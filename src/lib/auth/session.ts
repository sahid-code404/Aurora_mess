/**
 * SESSIONS — opaque 256-bit tokens; ONLY the sha256 hash is stored (spec §10).
 * Cookie: mes_session (HttpOnly, Path=/) with rotation on login.
 *
 * TRANSPORT:
 * - Normal deployments authenticate exclusively through the HttpOnly cookie.
 * - Cross-site sandbox previews may explicitly opt into a bearer fallback by
 *   setting ENABLE_PREVIEW_BEARER_AUTH=1 on the server. When enabled, login may
 *   return the raw token to the client for in-memory-only transport in browsers
 *   that block third-party cookies entirely. The fallback is disabled by
 *   default and is never required for normal production operation.
 *
 * Two cookie variants are emitted for compatibility with both HTTPS embedded
 * previews and plain-HTTP local development: SameSite=Lax first, then
 * SameSite=None; Secure. Browsers accept the variant valid for their context.
 */
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

export const SESSION_COOKIE = "mes_session";
const SESSION_TTL_DAYS = 30;

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Whether the explicitly preview-only bearer transport is enabled. */
export function previewBearerAuthEnabled(): boolean {
  return process.env.ENABLE_PREVIEW_BEARER_AUTH === "1";
}

export type SessionUser = {
  id: string;
  institutionId: string;
  role: "ADMIN" | "RESIDENT";
  status: string;
  email: string;
  sessionId: string;
};

/** Extract a preview bearer token from Authorization when the fallback is enabled. */
export function bearerToken(req: NextRequest): string | null {
  if (!previewBearerAuthEnabled()) return null;
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join("").trim();
  return token.length > 0 ? token : null;
}

/**
 * Create a session and revoke every current session transport this browser can
 * reach. Returns the raw token so the caller can set HttpOnly cookies; when
 * preview bearer auth is explicitly enabled, login may also return it to the
 * client for in-memory fallback transport.
 */
export async function createSession(
  userId: string,
  institutionId: string,
  req: NextRequest
): Promise<string> {
  const oldTokens = new Set(
    [req.cookies.get(SESSION_COOKIE)?.value, bearerToken(req)].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    )
  );
  for (const oldToken of oldTokens) {
    await db.session.updateMany({
      where: { tokenHash: sha256(oldToken) },
      data: { revokedAt: new Date() },
    });
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({
    data: {
      userId,
      institutionId,
      tokenHash: sha256(token),
      ip: req.headers.get("x-forwarded-for") ?? undefined,
      userAgent: req.headers.get("user-agent")?.slice(0, 250) ?? undefined,
      expiresAt,
    },
  });
  return token;
}

/**
 * Append the dual Set-Cookie headers (Lax first, then None+Secure).
 * Over HTTPS the None/Secure cookie replaces the Lax one (iframe-safe);
 * over plain HTTP the Secure variant is rejected by the browser and the
 * Lax cookie survives. Same name/path → deterministic end state.
 */
export function applySessionCookies(res: NextResponse, token: string): void {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
  );
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=None; Secure`
  );
}

/** Resolve the session's user from a raw token (null when absent/expired/revoked). */
async function sessionUserForToken(token: string): Promise<SessionUser | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.status !== "ACTIVE") return null;
  return {
    id: session.user.id,
    institutionId: session.user.institutionId,
    role: session.user.role as "ADMIN" | "RESIDENT",
    status: session.user.status,
    email: session.user.email,
    sessionId: session.id,
  };
}

/**
 * Resolve the authenticated user: HttpOnly cookie first. The Authorization
 * header is considered only when ENABLE_PREVIEW_BEARER_AUTH=1.
 */
export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  if (cookieToken) {
    const user = await sessionUserForToken(cookieToken);
    if (user) return user;
  }
  const headerToken = bearerToken(req);
  if (headerToken && headerToken !== cookieToken) {
    return sessionUserForToken(headerToken);
  }
  return null;
}

/** Revoke the current session — cookie plus preview bearer transport when enabled. */
export async function revokeSession(req: NextRequest, res: NextResponse): Promise<void> {
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  const headerToken = bearerToken(req);
  const tokens = new Set(
    [cookieToken, headerToken].filter((v): v is string => typeof v === "string" && v.length > 0)
  );
  for (const token of tokens) {
    await db.session.updateMany({
      where: { tokenHash: sha256(token) },
      data: { revokedAt: new Date() },
    });
  }
  // Clear both cookie variants (deletion matches on name+path).
  const expired = "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0";
  res.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; ${expired}; HttpOnly; SameSite=Lax`);
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; ${expired}; HttpOnly; SameSite=None; Secure`
  );
}

/** Revoke every session of a user (deactivation, "logout all"). */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Update lastSeen (cheap, non-blocking). */
export async function touchSession(sessionId: string): Promise<void> {
  try {
    await db.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } });
  } catch {
    /* non-critical */
  }
}

/** Server-component friendly cookie read (login page gating). */
export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
