/**
 * POST /api/v1/admin/policy-exemptions/[id]/cancel { reason }
 * Ends one still-active exemption. The row remains immutable history; repeated
 * or post-expiry cancellation fails instead of emitting duplicate lifecycle
 * evidence.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { sweepOutbox } from "@/lib/outbox";
import { cancelDeficitPolicyExemption } from "@/lib/domain/policy-exemption";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const payload = await cancelDeficitPolicyExemption({
    institutionId: ctx.institutionId,
    exemptionId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
  });

  try {
    await sweepOutbox(20);
  } catch {
    /* asynchronous */
  }

  return {
    data: {
      id: payload.id,
      residentId: payload.residentId,
      policyType: payload.policyType,
      reason: payload.reason,
      startsAt: payload.startsAt.toISOString(),
      expiresAt: payload.expiresAt!.toISOString(),
      cancelled: true,
    },
  };
});
