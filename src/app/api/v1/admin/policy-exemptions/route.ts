/**
 * /api/v1/admin/policy-exemptions (auth ADMIN)
 * GET  — active deficit-policy exemptions with resident names.
 * POST — grant one {residentId, reason, expiresAt? (YYYY-MM-DD)}. Exemptions
 *        are never permanent: the date covers the FULL local day (end-of-day
 *        UTC instant) so an expiry of "2026-09-10" protects through that date.
 *        Audit + resident notification. ExpiresAt is required after v1 review:
 *        optional here — omitted means "until cancelled" (recorded, auditable).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { dateKeySchema, reasonSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  residentId: z.string().min(5, "Choose a resident."),
  reason: reasonSchema,
  expiresAt: dateKeySchema.optional(),
});

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const exemptions = await db.policyExemption.findMany({
    where: {
      institutionId: ctx.institutionId,
      policyType: "DEFICIT_RESTRICTION",
      startsAt: { lte: new Date() },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
  const residentIds = [...new Set(exemptions.map((e) => e.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({ where: { userId: { in: residentIds } }, select: { userId: true, fullName: true } })
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
      expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
      approvedByUserId: e.approvedByUserId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const resident = await db.user.findFirst({
    where: { id: body.residentId, institutionId: ctx.institutionId, role: "RESIDENT", status: "ACTIVE" },
  });
  if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);

  // Full-day coverage: midnight UTC of the date + 24h − 1ms (23:59:59.999).
  const expiresAt = body.expiresAt ? new Date(`${body.expiresAt}T23:59:59.999Z`) : null;

  const exemption = await db.$transaction(async (tx) => {
    const created = await tx.policyExemption.create({
      data: {
        institutionId: ctx.institutionId,
        residentId: resident.id,
        policyType: "DEFICIT_RESTRICTION",
        reason: body.reason,
        startsAt: new Date(),
        expiresAt,
        approvedByUserId: ctx.user.id,
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "POLICY_EXEMPTION_CREATED",
        entityType: "POLICY_EXEMPTION",
        entityId: created.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: "—",
        afterSummary: created.expiresAt ? `until ${created.expiresAt.toISOString()}` : "until cancelled",
        metadata: { residentId: resident.id, expiresAt: created.expiresAt?.toISOString() ?? null },
      },
      tx
    );
    await appendOutbox(
      ctx.institutionId,
      "NOTIFICATION",
      {
        userId: resident.id,
        institutionId: ctx.institutionId,
        type: "POLICY_EXEMPTION",
        title: "Meal restriction exemption granted",
        message: `You've been granted a temporary exemption from deficit meal restrictions${created.expiresAt ? " " + `until ${created.expiresAt.toISOString().slice(0, 10)}` : ""}.`,
        entityRef: created.id,
      },
      tx
    );
    return created;
  });

  sweepOutbox(20).catch(() => {});

  const profile = await db.userProfile.findUnique({ where: { userId: resident.id }, select: { fullName: true } });

  return {
    data: {
      id: exemption.id,
      residentId: exemption.residentId,
      residentName: profile?.fullName ?? "Resident",
      policyType: exemption.policyType,
      reason: exemption.reason,
      startsAt: exemption.startsAt.toISOString(),
      expiresAt: exemption.expiresAt ? exemption.expiresAt.toISOString() : null,
      approvedByUserId: exemption.approvedByUserId,
      createdAt: exemption.createdAt.toISOString(),
    },
  };
});
