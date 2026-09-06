/**
 * POST /api/v1/admin/tasks/[id]/cancel — cancel active task work with a
 * mandatory reason. Cancellation is allowed only before submission:
 * ASSIGNED | ACCEPTED | IN_PROGRESS -> CANCELLED.
 *
 * SUBMITTED work must be explicitly approved/rejected so billing readiness and
 * any purchase evidence cannot be bypassed. Completed/rejected/cancelled tasks
 * are terminal history.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { lockTaskLifecycleMutation } from "@/lib/domain/task-lifecycle";
import { queueNotification, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

const bodySchema = z.object({ reason: reasonSchema });
const CANCELLABLE = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    await lockTaskLifecycleMutation(tx, ctx.institutionId, ctx.params.id);

    const task = await tx.task.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!task) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
    if (!CANCELLABLE.has(task.status)) {
      throw new ApiError(
        CODES.TASK_INVALID_STATE,
        task.status === "SUBMITTED"
          ? "Submitted work must be approved or rejected instead of cancelled."
          : "This task can no longer be cancelled.",
        409
      );
    }

    const beforeStatus = task.status;
    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "CANCELLED", adminReviewReason: body.reason },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "TASK_CANCELLED",
        entityType: "TASK",
        entityId: task.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: beforeStatus }),
        afterSummary: JSON.stringify({ status: "CANCELLED" }),
        metadata: {
          description: task.description,
          taskType: task.taskType,
          residentId: task.assignedResidentId,
        },
      },
      tx
    );

    await queueNotification(
      {
        userId: task.assignedResidentId,
        institutionId: ctx.institutionId,
        type: "TASK_CANCELLED",
        title: "Task cancelled",
        message: `The task "${task.description}" was cancelled. Reason: ${body.reason}`,
        entityRef: task.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: task.id,
      types: ["TASK_ASSIGNED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason: `Task cancelled by admin: ${body.reason}`,
      client: tx,
    });

    return updated;
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: result.id,
      status: result.status,
      cancellationReason: result.adminReviewReason,
      updatedAt: result.updatedAt.toISOString(),
    },
  };
});
