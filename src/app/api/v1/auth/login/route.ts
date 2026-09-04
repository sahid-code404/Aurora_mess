/**
 * POST /api/v1/auth/login — public credential sign-in (spec §110).
 * Rate limits: 30 attempts / 15 min / IP (any traffic) and 10 FAILURES /
 * 15 min / IP+email. Only FAILED credential attempts count toward the
 * email bucket — successful sign-ins never lock anyone out, and one tester's
 * traffic can never block a different user (audit 9-c finding #6).
 * Failure message is generic (no enumeration). Non-ACTIVE accounts get
 * role-appropriate 403 codes. Success → session cookie (rotated) + bearer
 * fallback token.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES, ok } from "@/lib/errors";
import { clientIp, clientKey, rateLimit, rateLimitCheck, rateLimitCount } from "@/lib/rate-limit";
import { createSession, applySessionCookies } from "@/lib/auth/session";
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
  const ipLimit = rateLimit(clientKey(ctx.req, "login"), 30, 15 * 60 * 1000);
  if (!ipLimit.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      "Too many sign-in attempts from this connection. Please wait a few minutes and try again.",
      429
    );
  }

  const body = await parseBody(ctx.req, loginSchema);

  // Failure-based limiter per IP+email: brute-force protection without
  // counting successes (5 legit sign-ins used to self-lockout) and without
  // one network's testing blocking a different real user (global email key).
  const failKey = `login:fail:${clientIp(ctx.req)}:${body.email}`;
  const failLimit = rateLimitCheck(failKey, 10);
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
    rateLimitCount(failKey, 15 * 60 * 1000);
    throw new ApiError(CODES.INVALID_CREDENTIALS, "Email or password is incorrect.", 401);
  }
  const passwordOk = await verifyPassword(body.password, user.passwordHash);
  if (!passwordOk) {
    rateLimitCount(failKey, 15 * 60 * 1000);
    throw new ApiError(CODES.INVALID_CREDENTIALS, "Email or password is incorrect.", 401);
  }

  if (user.status === "PENDING_APPROVAL" || user.status === "CHANGES_REQUESTED") {
    throw new ApiError(CODES.ACCOUNT_PENDING, "Your account is waiting for admin approval.", 403);
  }
  if (user.status === "REJECTED") {
    throw new ApiError(CODES.ACCOUNT_REJECTED, "Your registration was declined.", 403);
  }
  if (user.status !== "ACTIVE") {
    // INACTIVE / PENDING_DELETION / anything unexpected.
    throw new ApiError(
      CODES.ACCOUNT_INACTIVE,
      "Your account is inactive. Please contact the administration.",
      403
    );
  }

  // Session first (rotates old sessions), then the envelope carries the raw
  // token back to the client — it persists the token as a Bearer fallback for
  // contexts where the browser refuses the session cookie (preview iframe).
  const sessionToken = await createSession(user.id, user.institutionId, ctx.req);
  const res = ok(
    {
      user: { id: user.id, email: user.email, role: user.role },
      profile: { fullName: user.profile?.fullName ?? "" },
      sessionToken,
    },
    undefined,
    ctx.requestId
  );
  applySessionCookies(res, sessionToken);
  return res;
});
