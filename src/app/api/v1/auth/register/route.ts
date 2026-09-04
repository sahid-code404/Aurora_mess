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
  // Spec requires accepting every published policy at registration. When the
  // instance has no published policies yet (bootstrap), an empty list is fine.
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
  const limit = rateLimit(clientKey(ctx.req, "register"), 5, 60 * 60 * 1000);
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

  // Deduplicate acceptances by policy (policyId → policyVersionId).
  const acceptanceByPolicy = new Map<string, string>();
  for (const acceptance of body.acceptances) {
    acceptanceByPolicy.set(acceptance.policyId, acceptance.policyVersionId);
  }

  const activePolicyCount = await db.policy.count({
    where: { institutionId: institution.id, status: "ACTIVE" },
  });
  if (activePolicyCount > 0 && acceptanceByPolicy.size === 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "You must accept the policies to continue.", 400, {
      acceptances: "Please accept the required policies.",
    });
  }

  // Verify every accepted version belongs to an ACTIVE policy of this institution.
  const versionIds = [...acceptanceByPolicy.values()];
  const versions = versionIds.length
    ? await db.policyVersion.findMany({
        where: { id: { in: versionIds } },
        include: { policy: true },
      })
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  for (const [policyId, versionId] of acceptanceByPolicy) {
    const version = versionById.get(versionId);
    if (
      !version ||
      version.policyId !== policyId ||
      version.policy.institutionId !== institution.id ||
      version.policy.status !== "ACTIVE"
    ) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "The policy you accepted has changed. Please refresh and try again.",
        400,
        { acceptances: "Policy versions could not be verified." }
      );
    }
  }

  const passwordHash = await hashPassword(body.password);
  const ip = ctx.req.headers.get("x-forwarded-for") ?? null;
  const userAgent = ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null;

  try {
    await db.$transaction(async (tx) => {
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
      for (const [policyId, policyVersionId] of acceptanceByPolicy) {
        await tx.userPolicyAcceptance.create({
          data: { userId: user.id, policyId, policyVersionId, ip, userAgent },
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
