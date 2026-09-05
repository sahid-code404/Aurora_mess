/**
 * POST /api/v1/auth/register/resubmit — repair a CHANGES_REQUESTED application.
 *
 * This is deliberately PUBLIC in session terms because CHANGES_REQUESTED users
 * cannot enter the app. The endpoint authenticates the submitted email/password
 * itself, exposes no session, and only permits the narrow transition
 * CHANGES_REQUESTED -> PENDING_APPROVAL while updating editable profile fields
 * and current policy acceptances.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { appendAudit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { validateCurrentRegistrationAcceptances } from "@/lib/auth/registration-policies";
import { notifyAdmins, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";
import {
  emailSchema,
  fullNameSchema,
  phoneSchema,
  roomSchema,
} from "@/lib/validation";

const resubmitSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
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

let dummyHash: string | null = null;

async function burnUnknownCredentialTiming(password: string): Promise<void> {
  dummyHash ??= await hashPassword("registration-resubmit-timing-equalizer");
  await verifyPassword(password, dummyHash);
}

export const POST = route({ auth: "PUBLIC" }, async (ctx) => {
  const rl = await rateLimit(clientKey(ctx.req, "registration-resubmit"), 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      "Too many application updates from this connection. Please try again later.",
      429
    );
  }

  const body = await parseBody(ctx.req, resubmitSchema);
  const user = await db.user.findUnique({ where: { email: body.email }, include: { profile: true } });

  if (!user) {
    await burnUnknownCredentialTiming(body.password);
    throw new ApiError(CODES.INVALID_CREDENTIALS, "Email or password is incorrect.", 401);
  }
  const passwordOk = await verifyPassword(body.password, user.passwordHash);
  if (!passwordOk) {
    throw new ApiError(CODES.INVALID_CREDENTIALS, "Email or password is incorrect.", 401);
  }
  if (user.role !== "RESIDENT") {
    throw new ApiError(CODES.FORBIDDEN, "This application cannot be updated here.", 403);
  }
  if (user.status === "PENDING_APPROVAL") {
    throw new ApiError(CODES.ACCOUNT_PENDING, "Your updated application is already waiting for approval.", 409);
  }
  if (user.status === "REJECTED") {
    throw new ApiError(CODES.ACCOUNT_REJECTED, "Your registration was declined.", 409);
  }
  if (user.status !== "CHANGES_REQUESTED") {
    throw new ApiError(
      CODES.RESOURCE_CHANGED,
      "This application no longer needs corrections. Return to sign in and check its latest status.",
      409
    );
  }

  const ip = ctx.req.headers.get("x-forwarded-for") ?? null;
  const userAgent = ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null;

  const result = await db.$transaction(async (tx) => {
    // Claim the lifecycle transition before mutating profile data. If Admin
    // approves/rejects at the same moment, only one state transition may win.
    const guard = await tx.user.updateMany({
      where: {
        id: user.id,
        institutionId: user.institutionId,
        role: "RESIDENT",
        status: "CHANGES_REQUESTED",
      },
      data: { status: "PENDING_APPROVAL" },
    });
    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This application changed just now. Return to sign in and check its latest status.",
        409
      );
    }

    const currentAcceptances = await validateCurrentRegistrationAcceptances(
      user.institutionId,
      body.acceptances,
      tx
    );

    const profile = await tx.userProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        fullName: body.fullName,
        phone: body.phone || null,
        roomNumber: body.room || null,
      },
      update: {
        fullName: body.fullName,
        phone: body.phone || null,
        roomNumber: body.room || null,
      },
    });
    if (user.userProfileId !== profile.id) {
      await tx.user.update({ where: { id: user.id }, data: { userProfileId: profile.id } });
    }

    const requiredVersionIds = currentAcceptances.map((acceptance) => acceptance.policyVersionId);
    const existing = requiredVersionIds.length
      ? await tx.userPolicyAcceptance.findMany({
          where: { userId: user.id, policyVersionId: { in: requiredVersionIds } },
          select: { policyVersionId: true },
        })
      : [];
    const existingVersionIds = new Set(existing.map((acceptance) => acceptance.policyVersionId));
    for (const acceptance of currentAcceptances) {
      if (existingVersionIds.has(acceptance.policyVersionId)) continue;
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

    await tx.userStatusHistory.create({
      data: {
        userId: user.id,
        fromStatus: "CHANGES_REQUESTED",
        toStatus: "PENDING_APPROVAL",
        changedByUserId: user.id,
        reason: "Corrected application resubmitted by resident",
      },
    });

    await appendAudit(
      {
        institutionId: user.institutionId,
        actorUserId: user.id,
        actorRole: "RESIDENT",
        action: "RESIDENT_APPLICATION_RESUBMITTED",
        entityType: "USER",
        entityId: user.id,
        requestId: ctx.requestId,
        reason: "Corrected application resubmitted",
        beforeSummary: JSON.stringify({
          status: "CHANGES_REQUESTED",
          fullName: user.profile?.fullName ?? null,
          phone: user.profile?.phone ?? null,
          room: user.profile?.roomNumber ?? null,
        }),
        afterSummary: JSON.stringify({
          status: "PENDING_APPROVAL",
          fullName: body.fullName,
          phone: body.phone || null,
          room: body.room || null,
          acceptedPolicies: currentAcceptances.length,
        }),
        ip,
        userAgent,
      },
      tx
    );

    await notifyAdmins(
      user.institutionId,
      {
        type: "RESIDENT_APPLICATION_RESUBMITTED",
        title: "Resident application resubmitted",
        message: `${body.fullName} corrected and resubmitted their registration for review.`,
        entityRef: user.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: user.institutionId,
      entityRef: user.id,
      types: ["ACCOUNT_CHANGES_REQUESTED"],
      actorUserId: user.id,
      actorRole: "RESIDENT",
      reason: "Requested registration corrections were resubmitted",
      client: tx,
    });

    return { id: user.id, status: "PENDING_APPROVAL" as const };
  });

  await sweepOutboxSafe();
  return { data: result };
});
