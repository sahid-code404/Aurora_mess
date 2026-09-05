/**
 * POST /api/v1/auth/login — public credential sign-in (spec §110).
 * Rate limits: 30 attempts / 15 min / IP (any traffic) and 10 FAILURES /
 * 15 min / IP+email. Only FAILED credential attempts count toward the
 * email bucket — successful sign-ins never lock anyone out, and one tester's
 * traffic can never block a different user.
 *
 * ACTIVE accounts receive a rotated HttpOnly session. Non-active accounts do
 * not receive a session. A credential-verified CHANGES_REQUESTED applicant gets
 * the correction reason/current profile fields so the public auth screen can
 * offer a narrowly scoped resubmission flow without granting application access.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES, ok } from "@/lib/errors";
import { clientIp, clientKey, rateLimit, rateLimitCheck, rateLimitCount } from "@/lib/rate-limit";
import { createSession, applySessionCookies, previewBearerAuthEnabled } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { emailSchema } from "@/lib/validation";

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password.").max(128),
});

let dummyHash: string | null = null;

/** Burn equivalent CPU for unknown emails so timing does not reveal existence. */
async function equalizeTiming(password: string): Promise<void> {
  dummyHash ??= await hashPassword("timing-equalizer-not-a-real-password");
  await verifyPassword(password, dummyHash);
}

export const POST = route({ auth: "PUBLIC" }, async (ctx) => {
  const ipLimit = await rateLimit(clientKey(ctx.req, "login"), 30, 15 * 60 * 1000);
  if (!ipLimit.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      "Too many sign-in attempts from this connection. Please wait a few minutes and try again.",
      429
    );
  }

  const body = await parseBody(ctx.req, loginSchema);

  const failKey = `login:fail:${clientIp(ctx.req)}:${body.email}`;
  const failLimit = await rateLimitCheck(failKey, 10);
  if (!failLimit.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      "Too many failed sign-in attempts for this account. Please wait a few minutes and try again.",
      429
    );
  }

  const user = await db.user.findUnique({
    where: { email: body.email },
    include: { profile: true },
  });
  if (!user) {
    await equalizeTiming(body.password);
    await rateLimitCount(failKey, 15 * 60 * 1000);
    throw new ApiError(CODES.INVALID_CREDENTIALS, "Email or password is incorrect.", 401);
  }
  const passwordOk = await verifyPassword(body.password, user.passwordHash);
  if (!passwordOk) {
    await rateLimitCount(failKey, 15 * 60 * 1000);
    throw new ApiError(CODES.INVALID_CREDENTIALS, "Email or password is incorrect.", 401);
  }

  if (user.status === "CHANGES_REQUESTED") {
    const latestRequest = await db.userStatusHistory.findFirst({
      where: { userId: user.id, toStatus: "CHANGES_REQUESTED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { reason: true },
    });
    throw new ApiError(
      CODES.ACCOUNT_CHANGES_REQUESTED,
      "Your application needs changes before it can be approved.",
      403,
      {
        reviewReason: latestRequest?.reason ?? "Please review your application details and resubmit.",
        fullName: user.profile?.fullName ?? "",
        phone: user.profile?.phone ?? "",
        room: user.profile?.roomNumber ?? "",
      }
    );
  }
  if (user.status === "PENDING_APPROVAL") {
    throw new ApiError(CODES.ACCOUNT_PENDING, "Your account is waiting for admin approval.", 403);
  }
  if (user.status === "REJECTED") {
    throw new ApiError(CODES.ACCOUNT_REJECTED, "Your registration was declined.", 403);
  }
  if (user.status !== "ACTIVE") {
    throw new ApiError(
      CODES.ACCOUNT_INACTIVE,
      "Your account is inactive. Please contact the administration.",
      403
    );
  }

  const sessionToken = await createSession(user.id, user.institutionId, ctx.req);
  const data = {
    user: { id: user.id, email: user.email, role: user.role },
    profile: { fullName: user.profile?.fullName ?? "" },
    ...(previewBearerAuthEnabled() ? { sessionToken } : {}),
  };
  const res = ok(data, undefined, ctx.requestId);
  applySessionCookies(res, sessionToken);
  return res;
});
