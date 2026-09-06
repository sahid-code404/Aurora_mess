/**
 * POST /api/v1/admin/residents/[id]/cancel-deletion { reason }
 * Restores a resident from the still-open seven-day deletion safety window.
 * Completed tombstones are intentionally not restorable through this path.
 */
import { z } from "zod";
import { parseBody, route } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { sweepOutbox } from "@/lib/outbox";
import {
  cancelResidentDeletion,
  serializeResidentDeletionRequest,
} from "@/lib/domain/resident-retirement";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, z.object({ reason: reasonSchema }));
  const result = await cancelResidentDeletion({
    institutionId: ctx.institutionId,
    residentId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
  });

  try {
    await sweepOutbox();
  } catch {
    /* asynchronous */
  }

  return {
    data: {
      id: result.resident.id,
      status: result.resident.status,
      deletionRequest: serializeResidentDeletionRequest(result.request),
    },
  };
});
