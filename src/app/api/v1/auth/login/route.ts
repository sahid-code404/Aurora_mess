/**
 * POST /api/v1/auth/login — public credential sign-in (spec §110).
 * Rate limits: 30 attempts / 15 min / IP (any traffic) and 10 FAILURES /
 * 15 min / IP+email. Only FAILED credential attempts count toward the
 * email bucket — successful sign-ins never lock anyone out, and one tester's
 * traffic can never block a different user (audit 9-c finding #6).
 * Failure message is generic (no enumeration). Non-ACTIVE accounts get
 * role-appropriate 403 codes. Success always sets the rotated HttpOnly session
 * cookie. A raw bearer token is returned only when the server explicitly sets
 * ENABLE_PREVIEW_BEARER_AUTH=1 for cookie-blocked preview testing.
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
  // IP-level cap on total login traffic (secondary abuse guard; generous so
  // multiple testers behind one gateway IP are unaffected).
  const ipLimit = await rateLimit(clientKey(ctx.req, "login"), 30, 15 * 60 * 1000);
  if (!ipLimit.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      "Too many sign-in attempts from this connection. Please wait a few minutes and try again.",
      429
    );
  }

  const body = await parseBody(ctx.req, loginSchema);

  // Failure-based limiter per IP+email: brute-force protection without
  // counting successes and without one network's testing blocking another user.
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

  if (user.status === "PENDING_APPROVAL" || user.status === "CHANGES_REQUESTED") {
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
