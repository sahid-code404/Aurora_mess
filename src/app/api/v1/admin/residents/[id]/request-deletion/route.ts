/**
 * POST /api/v1/admin/residents/[id]/request-deletion { reason }
 * ACTIVE -> PENDING_DELETION with a seven-day reversible safety window.
 * Historical financial and audit records are never erased.
 */
import { z } from "zod";
import { parseBody, route } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { revokeAllUserSessions } from "@/lib/auth/session";
import { sweepOutbox } from "@/lib/outbox";
import {
  scheduleResidentDeletion,
  serializeResidentDeletionRequest,
} from "@/lib/domain/resident-retirement";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, z.object({ reason: reasonSchema }));
  const result = await scheduleResidentDeletion({
    institutionId: ctx.institutionId,
    residentId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
  });

  // PENDING_DELETION is non-loginable. Revoke every already-issued session
  // immediately after the authoritative transaction commits.
  await revokeAllUserSessions(ctx.params.id);
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
