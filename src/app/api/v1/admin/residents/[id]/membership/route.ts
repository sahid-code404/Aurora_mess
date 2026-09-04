/**
 * PATCH /api/v1/admin/residents/[id]/membership { membershipEffectiveFrom,
 * membershipEffectiveUntil } — ISO 8601 strings, or null to clear.
 * Audited as RESIDENT_MEMBERSHIP_EDITED with before/after.
 * Guard: moving the from-date INTO a closed billing period is restricted —
 * if the new from-date is earlier than the start of any BILLED period, the
 * request fails with VALIDATION_FAILED (409).
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { getInstitution } from "@/lib/institution";
import { zonedTimeToUtc } from "@/lib/time";

const membershipSchema = z.object({
  membershipEffectiveFrom: z.union([z.string().min(4).max(40), z.null()]).optional(),
  membershipEffectiveUntil: z.union([z.string().min(4).max(40), z.null()]).optional(),
});

function parseIso(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
      [field]: "Enter a valid date and time.",
    });
  }
  return date;
}

export const PATCH = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const user = await db.user.findFirst({
    where: { id, institutionId: ctx.institutionId, role: "RESIDENT" },
  });
  if (!user) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }

  const body = await parseBody(ctx.req, membershipSchema);
  const newFrom =
    body.membershipEffectiveFrom === undefined
      ? user.membershipEffectiveFrom
      : body.membershipEffectiveFrom === null
        ? null
        : parseIso(body.membershipEffectiveFrom, "membershipEffectiveFrom");
  const newUntil =
    body.membershipEffectiveUntil === undefined
      ? user.membershipEffectiveUntil
      : body.membershipEffectiveUntil === null
        ? null
        : parseIso(body.membershipEffectiveUntil, "membershipEffectiveUntil");

  if (newFrom && newUntil && newUntil < newFrom) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
      membershipEffectiveUntil: "The end date must be on or after the start date.",
    });
  }

  // Closed-period guard: a changed from-date may not land before any BILLED
  // period's start (that would rewrite history inside a closed period).
  const fromChanging =
    newFrom !== null && newFrom.getTime() !== user.membershipEffectiveFrom?.getTime();
  if (fromChanging && newFrom) {
    const institution = await getInstitution(ctx.institutionId);
    const timezone = institution?.timezone ?? "UTC";
    const billedPeriods = await db.billingPeriod.findMany({
      where: { institutionId: ctx.institutionId, status: "BILLED" },
      select: { year: true, month: true },
    });
    const billedStarts = billedPeriods.map((p) => zonedTimeToUtc(p.year, p.month, 1, 0, 0, timezone));
    if (billedStarts.some((start) => newFrom < start)) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Changing membership into a closed billing period is restricted.",
        409
      );
    }
  }

  const before = {
    membershipEffectiveFrom: user.membershipEffectiveFrom,
    membershipEffectiveUntil: user.membershipEffectiveUntil,
  };
  const after = { membershipEffectiveFrom: newFrom, membershipEffectiveUntil: newUntil };

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { membershipEffectiveFrom: newFrom, membershipEffectiveUntil: newUntil },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_MEMBERSHIP_EDITED",
        entityType: "USER",
        entityId: id,
        requestId: ctx.requestId,
        reason: "Membership window edited",
        beforeSummary: JSON.stringify(before),
        afterSummary: JSON.stringify(after),
        ip: ctx.req.headers.get("x-forwarded-for") ?? null,
        userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
      },
      tx
    );
  });

  return { data: { id, ...after } };
});
