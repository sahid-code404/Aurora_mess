/**
 * PATCH /api/v1/admin/residents/[id]/membership { membershipEffectiveFrom,
 * membershipEffectiveUntil } — ISO 8601 strings, or null to clear.
 *
 * Membership dates are financial inputs: they affect meal eligibility,
 * resident-count variables and billing. The mutation therefore serializes with
 * bill generation (Institution -> Resident lock order) and cannot rewrite a
 * BILLED period unless that period is explicitly reopened first.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";
import { assertMembershipWindowPreservesBilledHistory } from "@/lib/domain/membership-window";

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
  const body = await parseBody(ctx.req, membershipSchema);

  const after = await db.$transaction(async (tx) => {
    // Global financial lock order: Institution -> resident User row.
    await lockInstitutionFinancialMutation(tx, ctx.institutionId);
    await lockResidentLifecycleMutation(tx, ctx.institutionId, id);

    const [user, institution] = await Promise.all([
      tx.user.findUnique({ where: { id } }),
      tx.institution.findUnique({ where: { id: ctx.institutionId }, select: { timezone: true } }),
    ]);
    if (!user) {
      throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
    }
    if (!institution) {
      throw new ApiError(CODES.NOT_FOUND, "Institution not found.", 404);
    }

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

    const before = {
      membershipEffectiveFrom: user.membershipEffectiveFrom,
      membershipEffectiveUntil: user.membershipEffectiveUntil,
    };
    const next = {
      membershipEffectiveFrom: newFrom,
      membershipEffectiveUntil: newUntil,
    };

    await assertMembershipWindowPreservesBilledHistory(
      tx,
      ctx.institutionId,
      institution.timezone,
      before,
      next
    );

    await tx.user.update({
      where: { id },
      data: next,
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
        afterSummary: JSON.stringify(next),
        ip: ctx.req.headers.get("x-forwarded-for") ?? null,
        userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
      },
      tx
    );

    return next;
  });

  return { data: { id, ...after } };
});
