/**
 * POST /api/v1/admin/leave-requests/[id]/approve — spec §35, §43:
 * Transaction: Resident mutex + authoritative ACTIVE/leave reads → APPROVED
 * (+audit +notification) → re-evaluate only the resident's UNLOCKED meals
 * covered by the leave's ALL/SELECTED meal scope. Already-locked meals remain
 * frozen (§36). A stale pending leave cannot be approved after access removal.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import {
  buildEvalContext,
  evaluateResidentMeal,
  keyOfUtcDate,
  parseSnapshot,
  requireInstitutionContext,
} from "@/lib/domain/meal-engine";
import { mealInstanceScopeWhere, serializeSelectedMeals } from "@/lib/domain/meal-scope";
import { queueNotification, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";
import {
  lockResidentLifecycleMutation,
  requireActiveResidentAfterLock,
} from "@/lib/domain/resident-lifecycle";

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  // residentId is immutable ownership metadata. Use it only to locate the User
  // mutex; all leave lifecycle state is re-read after that mutex is acquired.
  const target = await db.leaveRequest.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId },
    select: { residentId: true },
  });
  if (!target) throw new ApiError(CODES.NOT_FOUND, "This leave request could not be found.", 404);

  const result = await db.$transaction(async (tx) => {
    await lockResidentLifecycleMutation(tx, ctx.institutionId, target.residentId);
    const resident = await requireActiveResidentAfterLock(tx, ctx.institutionId, target.residentId);

    const leave = await tx.leaveRequest.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId, residentId: target.residentId },
      include: {
        selectedMeals: {
          include: { mealDefinition: { select: { id: true, name: true } } },
        },
      },
    });
    if (!leave) throw new ApiError(CODES.NOT_FOUND, "This leave request could not be found.", 404);
    if (leave.status !== "PENDING") {
      throw new ApiError(CODES.VALIDATION_FAILED, "This leave request was already reviewed.", 409);
    }
    if (leave.mealScope === "SELECTED_MEALS" && leave.selectedMeals.length === 0) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This selected-meal leave has no meal selections. It cannot be approved safely.",
        409
      );
    }

    const now = new Date();
    const reviewReason = body.reason ?? null;
    const guard = await tx.leaveRequest.updateMany({
      where: {
        id: leave.id,
        institutionId: ctx.institutionId,
        residentId: resident.id,
        status: "PENDING",
      },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason,
      },
    });
    if (guard.count != 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This leave request was cancelled or reviewed just now. Refresh to see its latest state.",
        409
      );
    }
    const updated = { id: leave.id, status: "APPROVED", reviewedAt: now, reviewReason };

    const selectedIds = leave.selectedMeals.map((selection) => selection.mealDefinitionId);
    const scopeWhere = mealInstanceScopeWhere(leave.mealScope, selectedIds);

    // lockAt is the authoritative freeze boundary (min(cutoff, service start)).
    // A leave approved after lockAt must never retroactively rewrite that meal,
    // even when an unusual schedule has service start before the configured cutoff.
    const instances = await tx.mealInstance.findMany({
      where: {
        institutionId: ctx.institutionId,
        serviceDate: { gte: leave.startDate, lte: leave.endDate },
        ...scopeWhere,
        lockAt: { gt: now },
      },
      include: { definition: true, definitionVersion: true },
    });
    const instanceIds = instances.map((i) => i.id);
    const rms = instanceIds.length
      ? await tx.residentMeal.findMany({
          where: { residentId: leave.residentId, mealInstanceId: { in: instanceIds } },
        })
      : [];

    const instById = new Map(instances.map((i) => [i.id, i]));

    let updatedMeals = 0;
    let mealsOnLeave = 0;
    for (const rm of rms) {
      const instance = instById.get(rm.mealInstanceId);
      if (!instance) continue;
      const evalCtx = await buildEvalContext({
        resident: resident as never,
        institutionId: ctx.institutionId,
        instance: instance as never,
        definition: instance.definition as never,
        snapshot: parseSnapshot(instance.definitionVersion?.configSnapshotJson),
        rm: rm as never,
        client: tx,
        overrides: { onLeave: true, skipPolicy: false },
      });
      const resultEval = evaluateResidentMeal(rm as never, evalCtx);
      await tx.residentMeal.update({
        where: { id: rm.id },
        data: {
          effectiveState: resultEval.effectiveState,
          effectiveReason: resultEval.effectiveReason,
          policyState: evalCtx.restricted ? "RESTRICTED" : null,
          leaveState: "ON_LEAVE",
        },
      });
      updatedMeals++;
      if (resultEval.effectiveState === "ON_LEAVE") mealsOnLeave++;
    }

    const scopeSummary = serializeSelectedMeals(leave.mealScope, leave.selectedMeals);
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "LEAVE_APPROVED",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        requestId: ctx.requestId,
        reason: body.reason ?? null,
        beforeSummary: JSON.stringify({ status: "PENDING", ...scopeSummary }),
        afterSummary: JSON.stringify({
          status: "APPROVED",
          startDate: keyOfUtcDate(leave.startDate),
          endDate: keyOfUtcDate(leave.endDate),
          ...scopeSummary,
          updatedMeals,
          mealsOnLeave,
        }),
        metadata: {
          residentId: leave.residentId,
          mealScope: leave.mealScope,
          mealDefinitionIds: selectedIds,
          updatedMeals,
          mealsOnLeave,
        },
      },
      tx
    );

    const mealNames = leave.selectedMeals.map((selection) => selection.mealDefinition.name);
    const scopeLabel = leave.mealScope === "SELECTED_MEALS" ? ` (${mealNames.join(", ")})` : "";
    await queueNotification(
      {
        userId: leave.residentId,
        institutionId: ctx.institutionId,
        type: "LEAVE_APPROVED",
        title: "Leave request approved",
        message: `Your leave request (${keyOfUtcDate(leave.startDate)} to ${keyOfUtcDate(leave.endDate)})${scopeLabel} was approved.`,
        entityRef: leave.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: leave.id,
      types: ["LEAVE_REQUESTED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason: `Leave request (${keyOfUtcDate(leave.startDate)} to ${keyOfUtcDate(leave.endDate)}) approved by admin`,
      client: tx,
    });

    return {
      updated,
      updatedMeals,
      mealsOnLeave,
      affectedInstances: instanceIds.length,
      scopeSummary,
    };
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: result.updated.id,
      status: result.updated.status,
      reviewedAt: result.updated.reviewedAt ? result.updated.reviewedAt.toISOString() : null,
      reviewReason: result.updated.reviewReason,
      ...result.scopeSummary,
      updatedMeals: result.updatedMeals,
      mealsOnLeave: result.mealsOnLeave,
      affectedInstances: result.affectedInstances,
    },
  };
});