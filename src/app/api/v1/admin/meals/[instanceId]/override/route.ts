/**
 * POST /api/v1/admin/meals/[instanceId]/override — admin override (spec §32).
 * Works even AFTER the cutoff (admin authority, mandatory reason + audit).
 * Sets adminOverrideState, bumps version, locks the row when past cutoff, and
 * recomputes the effective state (admin override wins over selection/baseline
 * but NOT over calendar/membership/leave precedence gates).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { formatDateLabel, formatTimeLabel } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import {
  buildEvalContext,
  calculateNormalMealState,
  ensureResidentMeals,
  evaluateResidentMeal,
  keyOfUtcDate,
  parseSnapshot,
  requireInstitutionContext,
} from "@/lib/domain/meal-engine";
import { queueNotification, sweepOutboxSafe } from "@/lib/domain/notify";

const bodySchema = z.object({
  residentId: z.string().min(1),
  state: z.enum(["ON", "OFF"]),
  reason: reasonSchema,
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const body = await parseBody(ctx.req, bodySchema);
  const instanceId = ctx.params.instanceId;

  const result = await db.$transaction(async (tx) => {
    const instance = await tx.mealInstance.findFirst({
      where: { id: instanceId, institutionId: ctx.institutionId },
      include: { definition: true, definitionVersion: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);

    const resident = await tx.user.findFirst({
      where: { id: body.residentId, institutionId: ctx.institutionId, role: "RESIDENT" },
    });
    if (!resident) {
      throw new ApiError(CODES.NOT_FOUND, "This resident could not be found.", 404);
    }
    if (resident.status !== "ACTIVE") {
      throw new ApiError(CODES.VALIDATION_FAILED, "Only active residents can be overridden.", 409);
    }

    // Materialize the resident's row for this date if missing (lazy engine).
    const dateKey = keyOfUtcDate(instance.serviceDate);
    await ensureResidentMeals(resident.id, ctx.institutionId, tz, dateKey, dateKey, tx);

    const rm = await tx.residentMeal.findUnique({
      where: { residentId_mealInstanceId: { residentId: resident.id, mealInstanceId: instance.id } },
    });
    if (!rm) {
      throw new ApiError(
        CODES.MEAL_NOT_AVAILABLE,
        "This resident was not a member on this date, so the meal cannot be overridden.",
        409
      );
    }

    const now = new Date();
    if (instance.status === "CANCELLED") {
      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);
    }
    const cutoffPassed = now.getTime() >= instance.lockAt.getTime();
    if (!cutoffPassed) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Admin override is only allowed after the meal cutoff has passed (${formatTimeLabel(instance.cutoffAt, tz)}). Before cutoff, residents manage their own meals.`,
        409
      );
    }
    const before = { state: rm.effectiveState, reason: rm.effectiveReason, version: rm.version };

    const evalCtx = await buildEvalContext({
      resident: resident as never,
      institutionId: ctx.institutionId,
      instance: instance as never,
      definition: instance.definition as never,
      snapshot: parseSnapshot(instance.definitionVersion?.configSnapshotJson),
      rm: { ...rm, adminOverrideState: null } as never,
      client: tx,
    });

    // Normal meal state is calculated first from default + resident choice + leave + restrictions + cutoff.
    const normal = calculateNormalMealState(evalCtx);

    // If Admin changes it back to normal: clear override, final = normal state, no Admin Override badge.
    const isResetToNormal = body.state === normal.effectiveState;
    const targetAdminOverride = isResetToNormal ? null : body.state;
    const after = evaluateResidentMeal(
      { ...rm, adminOverrideState: targetAdminOverride } as never,
      { ...evalCtx, adminOverride: targetAdminOverride }
    );

    // Past cutoff/locked meal → freeze/lock the row as part of the override (spec §32).
    const lockedAt = rm.lockedAt ?? (now.getTime() >= instance.cutoffAt.getTime() ? now : null);

    // Atomic optimistic-concurrency write (spec §32 — concurrent admin
    // overrides must not silently clobber each other; audit 9-b #3): the
    // version read above is part of the WHERE clause.
    const guard = await tx.residentMeal.updateMany({
      where: { id: rm.id, version: rm.version },
      data: {
        adminOverrideState: targetAdminOverride,
        effectiveState: after.effectiveState,
        effectiveReason: after.effectiveReason,
        policyState: evalCtx.restricted ? "RESTRICTED" : null,
        leaveState: evalCtx.onLeave ? "ON_LEAVE" : null,
        version: rm.version + 1,
        ...(lockedAt ? { lockedAt } : {}),
      },
    });
    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This meal was just changed by someone else. Please refresh and apply the override again.",
        409
      );
    }
    const updated = await tx.residentMeal.findUniqueOrThrow({ where: { id: rm.id } });

    const mealName = instance.definition?.name ?? "Meal";
    const serviceDate = keyOfUtcDate(instance.serviceDate);

    // Override history is never deleted; only current override is cleared.
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: isResetToNormal ? "MEAL_OVERRIDE_CLEARED" : "MEAL_OVERRIDDEN",
        entityType: "RESIDENT_MEAL",
        entityId: rm.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify(before),
        afterSummary: JSON.stringify({
          state: after.effectiveState,
          reason: after.effectiveReason,
          adminOverrideState: targetAdminOverride,
          cleared: isResetToNormal,
          version: updated.version,
        }),
        metadata: {
          residentId: resident.id,
          mealInstanceId: instance.id,
          mealName,
          serviceDate,
          lockedByOverride: lockedAt != null,
          cleared: isResetToNormal,
        },
      },
      tx
    );

    await queueNotification(
      {
        userId: resident.id,
        institutionId: ctx.institutionId,
        type: "MEAL_OVERRIDE",
        title: isResetToNormal ? "Admin override cleared" : "Meal changed by admin",
        message: isResetToNormal
          ? `Your ${mealName} on ${formatDateLabel(instance.serviceDate)} was restored to normal (${after.effectiveState}) by the admin.`
          : `Your ${mealName} on ${formatDateLabel(instance.serviceDate)} was changed to ${body.state} by the admin.`,
        entityRef: instance.id,
      },
      tx
    );

    return {
      residentMealId: updated.id,
      residentId: resident.id,
      mealInstanceId: instance.id,
      state: after.effectiveState,
      effectiveReason: after.effectiveReason,
      adminOverrideState: targetAdminOverride,
      overridden: after.effectiveReason === "ADMIN_OVERRIDE",
      locked: updated.lockedAt != null,
      lockedAt: updated.lockedAt ? updated.lockedAt.toISOString() : null,
      cutoffAt: instance.cutoffAt.toISOString(),
      version: updated.version,
    };
  });

  await sweepOutboxSafe();
  return { data: result, meta: { cutoffLabel: formatTimeLabel(new Date(result.cutoffAt), tz) } };
});
