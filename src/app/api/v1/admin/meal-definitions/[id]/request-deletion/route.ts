/**
 * POST /api/v1/admin/meal-definitions/[id]/request-deletion — spec §69:
 * tombstone intent. Creates a DeletionRequest (status QUEUED, scheduledFor
 * +30d) and stamps definition.deleteRequestedAt. The definition itself and its
 * full version history are preserved; only future generation is already
 * stopped via archive (requesting deletion requires an explicit reason).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    const def = await tx.mealDefinition.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
    if (def.deleteRequestedAt) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "A deletion request already exists for this meal definition.",
        409
      );
    }

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const request = await tx.deletionRequest.create({
      data: {
        institutionId: ctx.institutionId,
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        requestedByUserId: ctx.user.id,
        scheduledFor,
        reason: body.reason,
        status: "QUEUED",
      },
    });
    const updated = await tx.mealDefinition.update({
      where: { id: def.id },
      data: { deleteRequestedAt: now },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "MEAL_DELETION_REQUESTED",
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        requestId: ctx.requestId,
        reason: body.reason,
        afterSummary: JSON.stringify({
          name: def.name,
          deletionRequestId: request.id,
          scheduledFor: scheduledFor.toISOString(),
        }),
        metadata: { deletionRequestId: request.id, scheduledFor: scheduledFor.toISOString() },
      },
      tx
    );

    return { request, updated };
  });

  return {
    data: {
      deletionRequestId: result.request.id,
      definitionId: result.updated.id,
      status: result.request.status,
      scheduledFor: result.request.scheduledFor ? result.request.scheduledFor.toISOString() : null,
      reason: result.request.reason,
    },
  };
});
