/**
 * POST /api/v1/tasks/[id]/reject — resident rejects a task with a mandatory
 * reason (spec §60 state machine; rejection is allowed from ASSIGNED or
 * ACCEPTED — both pre-work states — documented decision). Audited; the
 * assigner is notified.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    });
    if (!task) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
    if (task.status !== "ASSIGNED" && task.status !== "ACCEPTED") {
      throw new ApiError(CODES.TASK_INVALID_STATE, "This task can no longer be rejected.", 409);
    }

    const before = { status: task.status };
    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "REJECTED", rejectionReason: body.reason },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "TASK_REJECTED",
        entityType: "TASK",
        entityId: task.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify(before),
        afterSummary: JSON.stringify({ status: "REJECTED" }),
        metadata: { description: task.description, taskType: task.taskType },
      },
      tx
    );

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "TASK_REJECTED",
        title: "Task rejected",
        message: `The task "${task.description}" was rejected. Reason: ${body.reason}`,
        entityRef: task.id,
      },
      tx
    );

    return updated;
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: result.id,
      status: result.status,
      rejectionReason: result.rejectionReason,
      updatedAt: result.updatedAt.toISOString(),
    },
  };
});
