/**
 * POST /api/v1/tasks/[id]/accept — resident accepts an assigned task.
 * ASSIGNED → ACCEPTED (+audit, notification to the assigner).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { lockTaskLifecycleMutation } from "@/lib/domain/task-lifecycle";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const result = await db.$transaction(async (tx) => {
    await lockTaskLifecycleMutation(tx, ctx.institutionId, ctx.params.id);

    const task = await tx.task.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    });
    if (!task) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
    if (task.status !== "ASSIGNED") {
      throw new ApiError(CODES.TASK_INVALID_STATE, "This task can no longer be accepted.", 409);
    }

    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "ACCEPTED" },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "TASK_ACCEPTED",
        entityType: "TASK",
        entityId: task.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ status: "ASSIGNED" }),
        afterSummary: JSON.stringify({ status: "ACCEPTED" }),
        metadata: { description: task.description, taskType: task.taskType },
      },
      tx
    );

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "TASK_ACCEPTED",
        title: "Task accepted",
        message: `The task "${task.description}" was accepted.`,
        entityRef: task.id,
      },
      tx
    );

    return updated;
  });

  await sweepOutboxSafe();
  return {
    data: { id: result.id, status: result.status, updatedAt: result.updatedAt.toISOString() },
  };
});
