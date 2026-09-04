/**
 * POST /api/v1/admin/policy-exemptions/[id]/cancel — end an exemption
 * {reason} (auth ADMIN). Sets expiresAt to now (the row is kept — exemptions
 * are audit history, never deleted) + audit event.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { reasonSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const payload = await db.$transaction(async (tx) => {
    const exemption = await tx.policyExemption.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!exemption) throw new ApiError(CODES.NOT_FOUND, "Exemption not found.", 404);

    const now = new Date();
    const updated = await tx.policyExemption.update({
      where: { id: exemption.id },
      data: { expiresAt: exemption.expiresAt && exemption.expiresAt < now ? exemption.expiresAt : now },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "POLICY_EXEMPTION_CANCELLED",
        entityType: "POLICY_EXEMPTION",
        entityId: exemption.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: exemption.expiresAt ? `until ${exemption.expiresAt.toISOString()}` : "until cancelled",
        afterSummary: `ended ${now.toISOString()}`,
        metadata: { residentId: exemption.residentId },
      },
      tx
    );

    return updated;
  });

  return {
    data: {
      id: payload.id,
      residentId: payload.residentId,
      policyType: payload.policyType,
      reason: payload.reason,
      startsAt: payload.startsAt.toISOString(),
      expiresAt: payload.expiresAt ? payload.expiresAt.toISOString() : null,
      cancelled: true,
    },
  };
});
