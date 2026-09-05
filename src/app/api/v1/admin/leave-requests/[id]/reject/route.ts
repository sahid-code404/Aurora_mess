/**
 * POST /api/v1/admin/leave-requests/[id]/reject — mandatory reason, audit,
 * notification to the resident. Meals already marked ON_LEAVE by a previous
 * approval are never touched by rejection (there is no un-approve path; meals
 * are only marked at approval time, spec §35).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { queueNotification, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

const bodySchema = z.object({ reason: reasonSchema });

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
    const guard = await tx.leaveRequest.updateMany({
      where: {
        id: leave.id,
        institutionId: ctx.institutionId,
        status: "PENDING",
      },
      data: {
        status: "REJECTED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason,
      },
    });
    if (guard.count != 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This leave request was cancelled or reviewed just now. Refresh to see its latest state.",
        409
      );
    }
    const updated = { id: leave.id, status: "REJECTED", reviewedAt: now, reviewReason: body.reason };

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "LEAVE_REJECTED",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: "PENDING" }),
        afterSummary: JSON.stringify({
          status: "REJECTED",
          startDate: keyOfUtcDate(leave.startDate),
          endDate: keyOfUtcDate(leave.endDate),
        }),
        metadata: { residentId: leave.residentId },
      },
      tx
    );

    await queueNotification(
      {
        userId: leave.residentId,
        institutionId: ctx.institutionId,
        type: "LEAVE_REJECTED",
        title: "Leave request rejected",
        message: `Your leave request (${keyOfUtcDate(leave.startDate)} to ${keyOfUtcDate(leave.endDate)}) was rejected. Reason: ${body.reason}`,
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
      reason: `Leave request (${keyOfUtcDate(leave.startDate)} to ${keyOfUtcDate(leave.endDate)}) rejected by admin: ${body.reason}`,
      client: tx,
    });

    return updated;
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: result.id,
      status: result.status,
      reviewReason: result.reviewReason,
      reviewedAt: result.reviewedAt ? result.reviewedAt.toISOString() : null,
    },
  };
});
