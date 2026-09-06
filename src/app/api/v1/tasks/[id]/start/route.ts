/**
 * POST /api/v1/tasks/[id]/start — resident starts an accepted task.
 * ACCEPTED → IN_PROGRESS (+audit).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { lockTaskLifecycleMutation } from "@/lib/domain/task-lifecycle";

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const result = await db.$transaction(async (tx) => {
    await lockTaskLifecycleMutation(tx, ctx.institutionId, ctx.params.id);

    const task = await tx.task.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    });
    if (!task) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
    if (task.status !== "ACCEPTED") {
      throw new ApiError(CODES.TASK_INVALID_STATE, "Only accepted tasks can be started.", 409);
    }

    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "IN_PROGRESS" },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "TASK_STARTED",
        entityType: "TASK",
        entityId: task.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ status: "ACCEPTED" }),
        afterSummary: JSON.stringify({ status: "IN_PROGRESS" }),
        metadata: { description: task.description, taskType: task.taskType },
      },
      tx
    );

    return updated;
  });

  return {
    data: { id: result.id, status: result.status, updatedAt: result.updatedAt.toISOString() },
  };
});
