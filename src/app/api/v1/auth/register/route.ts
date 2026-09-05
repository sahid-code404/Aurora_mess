/**
 * POST /api/v1/auth/register — public self-registration (spec §109).
 * Creates a RESIDENT in PENDING_APPROVAL with profile, status history and
 * policy-acceptance rows (ip + user agent captured). Login only after approval.
 * Rate limit: 5 / hour / IP. Email collision → EMAIL_TAKEN (409).
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { appendAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { getInstitution } from "@/lib/institution";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";
import { validateCurrentRegistrationAcceptances } from "@/lib/auth/registration-policies";
import {
  emailSchema,
  fullNameSchema,
  passwordSchema,
  phoneSchema,
  roomSchema,
} from "@/lib/validation";

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  phone: phoneSchema,
  room: roomSchema,
  acceptances: z
    .array(
      z.object({
        policyId: z.string().min(1).max(64),
        policyVersionId: z.string().min(1).max(64),
      })
    )
    .default([]),
});

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

export const POST = route({ auth: "PUBLIC" }, async (ctx) => {
  const limit = await rateLimit(clientKey(ctx.req, "register"), 5, 60 * 60 * 1000);
  if (!limit.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      "Too many registrations from this network. Please try again later.",
      429
    );
  }

  const institution = await getInstitution();
  if (!institution) {
    throw new ApiError(
      CODES.INTERNAL,
      "Registration is not available right now. Please try again later.",
      503
    );
  }

  const body = await parseBody(ctx.req, registerSchema);
  const passwordHash = await hashPassword(body.password);
  const ip = ctx.req.headers.get("x-forwarded-for") ?? null;
  const userAgent = ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null;

  try {
    await db.$transaction(async (tx) => {
      // Validate inside the transaction so policy publication cannot race the
      // registration write. Every currently published ACTIVE policy version
      // must be accepted, not merely one member of the set.
      const currentAcceptances = await validateCurrentRegistrationAcceptances(
        institution.id,
        body.acceptances,
        tx
      );

      const user = await tx.user.create({
        data: {
          institutionId: institution.id,
          role: "RESIDENT",
          status: "PENDING_APPROVAL",
          email: body.email,
          passwordHash,
        },
      });
      const profile = await tx.userProfile.create({
        data: {
          userId: user.id,
          fullName: body.fullName,
          phone: body.phone || null,
          roomNumber: body.room || null,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { userProfileId: profile.id } });
      await tx.userStatusHistory.create({
        data: {
          userId: user.id,
          fromStatus: null,
          toStatus: "PENDING_APPROVAL",
          changedByUserId: null,
          reason: "Registration submitted",
        },
      });
      for (const acceptance of currentAcceptances) {
        await tx.userPolicyAcceptance.create({
          data: {
            userId: user.id,
            policyId: acceptance.policyId,
            policyVersionId: acceptance.policyVersionId,
            ip,
            userAgent,
          },
        });
      }
      await appendAudit(
        {
          institutionId: institution.id,
          actorUserId: user.id,
          actorRole: "RESIDENT",
          action: "RESIDENT_REGISTERED",
          entityType: "USER",
          entityId: user.id,
          requestId: ctx.requestId,
          afterSummary: JSON.stringify({
            email: body.email,
            fullName: body.fullName,
            room: body.room || null,
            acceptedPolicies: currentAcceptances.length,
          }),
          ip,
          userAgent,
        },
        tx
      );

      await notifyAdmins(
        institution.id,
        {
          type: "RESIDENT_REGISTERED",
          title: "New resident registration",
          message: `${body.fullName} registered and is pending approval.`,
          entityRef: user.id,
        },
        tx
      );
    });

    await sweepOutboxSafe();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(CODES.EMAIL_TAKEN, "This email is already registered.", 409);
    }
    throw error;
  }

  return { data: { status: "PENDING_APPROVAL" } };
});
