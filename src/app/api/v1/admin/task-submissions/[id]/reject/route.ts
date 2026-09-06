/**
 * POST /api/v1/admin/task-submissions/[id]/reject — reject a submission with a
 * mandatory reason: submission → REJECTED, task → REJECTED_BY_ADMIN (+audit,
 * resident notification). No money moves, but SUBMITTED is a billing-readiness
 * blocker so its removal shares the institution billing mutex.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { queueNotification, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, ctx.institutionId);

    const submission = await tx.taskSubmission.findUnique({
      where: { id: ctx.params.id },
      include: { task: true },
    });
    if (!submission || submission.task.institutionId !== ctx.institutionId) {
      throw new ApiError(CODES.NOT_FOUND, "This submission could not be found.", 404);
    }
    if (submission.status !== "SUBMITTED") {
      throw new ApiError(CODES.TASK_INVALID_STATE, "This submission was already reviewed.", 409);
    }

    const now = new Date();
    await tx.taskSubmission.update({
      where: { id: submission.id },
      data: {
        status: "REJECTED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason,
      },
    });
    await tx.task.update({
      where: { id: submission.taskId },
      data: { status: "REJECTED_BY_ADMIN", adminReviewReason: body.reason },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "TASK_SUBMISSION_REJECTED",
        entityType: "TASK_SUBMISSION",
        entityId: submission.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: "SUBMITTED", claimedTotalMinor: submission.claimedTotalMinor }),
        afterSummary: JSON.stringify({ status: "REJECTED", taskStatus: "REJECTED_BY_ADMIN" }),
        metadata: { taskId: submission.taskId, residentId: submission.task.assignedResidentId },
      },
      tx
    );

    await queueNotification(
      {
        userId: submission.task.assignedResidentId,
        institutionId: ctx.institutionId,
        type: "TASK_REJECTED_BY_ADMIN",
        title:
          submission.task.taskType === "GENERAL"
            ? "Normal task completion rejected"
            : "Market task submission rejected",
        message:
          submission.task.taskType === "GENERAL"
            ? `Your completion for "${submission.task.description}" was rejected. Reason: ${body.reason}`
            : `Your purchase submission for "${submission.task.description}" was rejected. Reason: ${body.reason}`,
        entityRef: submission.taskId,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: submission.taskId,
      types: ["TASK_SUBMITTED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason:
        submission.task.taskType === "GENERAL"
          ? `Normal task completion rejected by admin: ${body.reason}`
          : `Market task purchase rejected by admin: ${body.reason}`,
      client: tx,
    });

    return { submissionId: submission.id, taskId: submission.taskId };
  });

  await sweepOutboxSafe();
  return {
    data: {
      submissionId: result.submissionId,
      taskId: result.taskId,
      status: "REJECTED",
      taskStatus: "REJECTED_BY_ADMIN",
      reviewReason: body.reason,
    },
  };
});