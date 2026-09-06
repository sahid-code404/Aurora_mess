/**
 * /api/v1/admin/policy-exemptions (auth ADMIN)
 * GET  — active deficit-policy exemptions with resident names.
 * POST — grant one finite {residentId, reason, expiresAt: YYYY-MM-DD}.
 *
 * Exemptions are never permanent. Their expiry covers the full institution
 * local calendar day and grant validation is serialized with Resident
 * lifecycle changes on the authoritative User row.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { sweepOutbox } from "@/lib/outbox";
import { dateKeySchema, reasonSchema } from "@/lib/validation";
import { grantDeficitPolicyExemption } from "@/lib/domain/policy-exemption";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  residentId: z.string().min(5, "Choose a resident."),
  reason: reasonSchema,
  expiresAt: dateKeySchema,
});

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const now = new Date();
  const exemptions = await db.policyExemption.findMany({
    where: {
      institutionId: ctx.institutionId,
      policyType: "DEFICIT_RESTRICTION",
      startsAt: { lte: now },
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });
  const residentIds = [...new Set(exemptions.map((e) => e.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({
        where: { userId: { in: residentIds } },
        select: { userId: true, fullName: true },
      })
    : [];
  const nameMap = new Map(profiles.map((p) => [p.userId, p.fullName]));

  return {
    data: exemptions.map((e) => ({
      id: e.id,
      residentId: e.residentId,
      residentName: nameMap.get(e.residentId) ?? "Resident",
      policyType: e.policyType,
      reason: e.reason,
      startsAt: e.startsAt.toISOString(),
      expiresAt: e.expiresAt.toISOString(),
      approvedByUserId: e.approvedByUserId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const exemption = await grantDeficitPolicyExemption({
    institutionId: ctx.institutionId,
    residentId: body.residentId,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
    expiresOn: body.expiresAt,
  });

  try {
    await sweepOutbox(20);
  } catch {
    /* asynchronous */
  }

  const profile = await db.userProfile.findUnique({
    where: { userId: exemption.residentId },
    select: { fullName: true },
  });

  return {
    data: {
      id: exemption.id,
      residentId: exemption.residentId,
      residentName: profile?.fullName ?? "Resident",
      policyType: exemption.policyType,
      reason: exemption.reason,
      startsAt: exemption.startsAt.toISOString(),
      expiresAt: exemption.expiresAt.toISOString(),
      approvedByUserId: exemption.approvedByUserId,
      createdAt: exemption.createdAt.toISOString(),
    },
  };
});
