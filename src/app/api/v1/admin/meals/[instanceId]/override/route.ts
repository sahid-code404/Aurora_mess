/**
 * POST /api/v1/admin/meals/[instanceId]/override — admin override (spec §32).
 * Works even AFTER the cutoff (admin authority, mandatory reason + audit).
 * Sets adminOverrideState, bumps version, locks the row when past cutoff, and
 * recomputes the effective state. Admin authority may override soft deficit
 * policy/Resident choice, but never calendar/account/membership/cutoff/leave
 * eligibility gates.
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
  hardMealEligibilityState,
  keyOfUtcDate,
  parseSnapshot,
  requireInstitutionContext,
} from "@/lib/domain/meal-engine";
import { queueNotification, sweepOutboxSafe } from "@/lib/domain/notify";
import { lockActiveResidentForMealMutation } from "@/lib/domain/resident-meal-mutation";

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
    const resident = await lockActiveResidentForMealMutation(tx, ctx.institutionId, body.residentId);

    const instance = await tx.mealInstance.findFirst({
      where: { id: instanceId, institutionId: ctx.institutionId },
      include: { definition: true, definitionVersion: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);

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

    const hardEligibility = hardMealEligibilityState(evalCtx);
    if (hardEligibility) {
      throw new ApiError(
        CODES.MEAL_NOT_AVAILABLE,
        `This meal cannot be overridden while its eligibility state is ${hardEligibility.effectiveReason.replace(/_/g, " ").toLowerCase()}.`,
        409
      );
    }

    const normal = calculateNormalMealState(evalCtx);
    const isResetToNormal = body.state === normal.effectiveState;
    const targetAdminOverride = isResetToNormal ? null : body.state;
    const after = evaluateResidentMeal(
      { ...rm, adminOverrideState: targetAdminOverride } as never,
      { ...evalCtx, adminOverride: targetAdminOverride }
    );

    const lockedAt = rm.lockedAt ?? (now.getTime() >= instance.cutoffAt.getTime() ? now : null);

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
