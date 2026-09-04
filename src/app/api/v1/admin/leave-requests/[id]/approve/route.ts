/**
 * POST /api/v1/admin/leave-requests/[id]/approve — spec §35:
 * Transaction: mark APPROVED (+audit +notification), then re-evaluate the
 * resident's UNLOCKED meals in the leave window (cutoffAt > now) — leave wins
 * over selection/baseline. Already-locked meals are untouched (frozen §36).
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
import { queueNotification, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    const leave = await tx.leaveRequest.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!leave) throw new ApiError(CODES.NOT_FOUND, "This leave request could not be found.", 404);
    if (leave.status !== "PENDING") {
      throw new ApiError(CODES.VALIDATION_FAILED, "This leave request was already reviewed.", 409);
    }

    const now = new Date();
    const updated = await tx.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason ?? null,
      },
    });

    // Re-evaluate ONLY unlocked meals in the window (locked stay frozen, §35-36).
    const instances = await tx.mealInstance.findMany({
      where: {
        institutionId: ctx.institutionId,
        serviceDate: { gte: leave.startDate, lte: leave.endDate },
        cutoffAt: { gt: now },
      },
      include: { definition: true, definitionVersion: true },
    });
    const instanceIds = instances.map((i) => i.id);
    const rms = instanceIds.length
      ? await tx.residentMeal.findMany({
          where: { residentId: leave.residentId, mealInstanceId: { in: instanceIds } },
        })
      : [];

    const resident = await tx.user.findUnique({ where: { id: leave.residentId } });
    const instById = new Map(instances.map((i) => [i.id, i]));

    let updatedMeals = 0;
    let mealsOnLeave = 0;
    for (const rm of rms) {
      const instance = instById.get(rm.mealInstanceId);
      if (!instance || !resident) continue;
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
        beforeSummary: JSON.stringify({ status: "PENDING" }),
        afterSummary: JSON.stringify({
          status: "APPROVED",
          startDate: keyOfUtcDate(leave.startDate),
          endDate: keyOfUtcDate(leave.endDate),
          updatedMeals,
          mealsOnLeave,
        }),
        metadata: { residentId: leave.residentId, updatedMeals, mealsOnLeave },
      },
      tx
    );

    await queueNotification(
      {
        userId: leave.residentId,
        institutionId: ctx.institutionId,
        type: "LEAVE_APPROVED",
        title: "Leave request approved",
        message: `Your leave request (${keyOfUtcDate(leave.startDate)} to ${keyOfUtcDate(leave.endDate)}) was approved.`,
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

    return { updated, updatedMeals, mealsOnLeave, affectedInstances: instanceIds.length };
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: result.updated.id,
      status: result.updated.status,
      reviewedAt: result.updated.reviewedAt ? result.updated.reviewedAt.toISOString() : null,
      reviewReason: result.updated.reviewReason,
      updatedMeals: result.updatedMeals,
      mealsOnLeave: result.mealsOnLeave,
      affectedInstances: result.affectedInstances,
    },
  };
});
