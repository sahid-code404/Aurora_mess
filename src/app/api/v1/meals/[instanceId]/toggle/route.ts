/**
 * POST /api/v1/meals/[instanceId]/toggle — resident ON/OFF toggle (spec §31).
 * Transaction: materialize-on-demand → load rm (unique resident+instance) →
 * server-time cutoff check → optimistic version check → availability check →
 * write selected state + recompute effective (full re-evaluation) → audit.
 * Server time is the ONLY clock (spec §16).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatTimeLabel } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import {
  buildEvalContext,
  ensureInstancesForRange,
  ensureResidentMeals,
  evaluateResidentMeal,
  keyOfUtcDate,
  parseSnapshot,
  requireInstitutionContext,
} from "@/lib/domain/meal-engine";

const bodySchema = z.object({
  state: z.enum(["ON", "OFF"]),
  expectedVersion: z.number().int().min(1),
});

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
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

    // Materialize this resident's row for this date if missing (lazy engine).
    const dateKey = keyOfUtcDate(instance.serviceDate);
    await ensureInstancesForRange(ctx.institutionId, tz, dateKey, dateKey, tx);
    await ensureResidentMeals(ctx.user.id, ctx.institutionId, tz, dateKey, dateKey, tx);

    const rm = await tx.residentMeal.findUnique({
      where: { residentId_mealInstanceId: { residentId: ctx.user.id, mealInstanceId: instance.id } },
    });
    if (!rm) {
      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal is not available for you.", 409);
    }

    const now = new Date();
    if (instance.status === "CANCELLED") {
      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);
    }
    // Server-time lock instant — never later than service start.
    if (now.getTime() >= instance.lockAt.getTime()) {
      throw new ApiError(
        CODES.MEAL_CUTOFF_PASSED,
        `This meal locked at ${formatTimeLabel(instance.lockAt, tz)}. Your change was not saved.`,
        409
      );
    }
    if (rm.version !== body.expectedVersion) {
      throw new ApiError(CODES.RESOURCE_CHANGED, "This meal was just changed. Please refresh.", 409);
    }

    const resident = await tx.user.findUnique({ where: { id: ctx.user.id } });
    if (!resident) throw new ApiError(CODES.INTERNAL, "Account could not be resolved.", 500);

    const evalCtx = await buildEvalContext({
      resident: resident as never,
      institutionId: ctx.institutionId,
      instance: instance as never,
      definition: instance.definition as never,
      snapshot: parseSnapshot(instance.definitionVersion?.configSnapshotJson),
      rm: rm as never,
      client: tx,
    });

    const current = evaluateResidentMeal(rm as never, evalCtx);
    if (rm.adminOverrideState != null || current.effectiveReason === "ADMIN_OVERRIDE") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "An administrator override is active on this meal. You cannot change it.",
        409
      );
    }
    if (current.effectiveState === "NOT_AVAILABLE" || current.effectiveState === "ON_LEAVE") {
      throw new ApiError(
        CODES.MEAL_NOT_AVAILABLE,
        "This meal isn't available to change right now.",
        409
      );
    }

    const before = { state: rm.effectiveState, reason: rm.effectiveReason, selected: rm.residentSelectedState };
    // Re-evaluate with the candidate row: context carries selection/adminOverride
    // (evaluateResidentMeal is pure — same inputs, same output).
    const candidateRm = { ...rm, residentSelectedState: body.state };
    const after = evaluateResidentMeal(candidateRm as never, { ...evalCtx, selected: body.state });

    // Atomic optimistic-concurrency write: the version is part of the WHERE
    // clause, so a racing toggle/override can never silently overwrite this
    // change (spec §72) — the loser gets RESOURCE_CHANGED (audit 9-b #2).
    const guard = await tx.residentMeal.updateMany({
      where: { id: rm.id, version: rm.version },
      data: {
        residentSelectedState: body.state,
        effectiveState: after.effectiveState,
        effectiveReason: after.effectiveReason,
        policyState: evalCtx.restricted ? "RESTRICTED" : null,
        leaveState: evalCtx.onLeave ? "ON_LEAVE" : null,
        version: rm.version + 1,
      },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.RESOURCE_CHANGED, "This meal was just changed. Please refresh.", 409);
    }
    const updated = await tx.residentMeal.findUniqueOrThrow({ where: { id: rm.id } });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "MEAL_TOGGLED",
        entityType: "RESIDENT_MEAL",
        entityId: rm.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify(before),
        afterSummary: JSON.stringify({ state: after.effectiveState, reason: after.effectiveReason, selected: body.state }),
        metadata: {
          mealInstanceId: instance.id,
          mealName: instance.definition?.name ?? null,
          serviceDate: dateKey,
          requested: body.state,
        },
      },
      tx
    );

    return {
      state: after.effectiveState,
      effectiveReason: after.effectiveReason,
      locked: updated.lockedAt != null,
      cutoffAt: instance.cutoffAt.toISOString(),
      version: updated.version,
      residentMealId: updated.id,
    };
  });

  return { data: result };
});
