/**
 * SESSIONS — opaque 256-bit tokens; ONLY the sha256 hash is stored (spec §10).
 * Cookie: mes_session (HttpOnly, Path=/) with rotation on login.
 *
 * TRANSPORT NOTE (why two Set-Cookie headers + a bearer fallback):
 * The app is embedded in a cross-site iframe by the sandbox preview panel.
 * Browsers reject `SameSite=Lax` cookies set in third-party iframe contexts,
 * which silently broke sign-in (login 200 → /auth/me 401 → stuck on the auth
 * screen). We therefore:
 *   1. Emit BOTH a `SameSite=Lax` and a `SameSite=None; Secure` Set-Cookie for
 *      the same token. Over HTTPS the None/Secure cookie replaces the Lax one
 *      and is accepted inside iframes; over plain HTTP the browser discards the
 *      Secure variant and the Lax cookie survives (local dev / E2E).
 *   2. Accept the session token via `Authorization: Bearer` as a fallback for
 *      browsers that block third-party cookies entirely (e.g. Safari ITP). The
 *      login response returns the token; the client keeps it in localStorage.
 * __Host- prefix reserved for real HTTPS production (documented in worklog).
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

export type SessionUser = {
  id: string;
  institutionId: string;
  role: "ADMIN" | "RESIDENT";
  status: string;
  email: string;
  sessionId: string;
};

/** Extract a bearer token from the Authorization header (null when absent). */
export function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join("").trim();
  return token.length > 0 ? token : null;
}

/**
 * Create a session and revoke every session this browser can reach (cookie AND
 * bearer token — rotation). Returns the raw token; the caller hands it to the
 * client as a Bearer fallback transport for cookie-blocked contexts and
 * stamps it onto the response via applySessionCookies().
 */
export async function createSession(
  userId: string,
  institutionId: string,
  req: NextRequest
): Promise<string> {
  // Rotate: revoke any current session reachable from this browser. In
  // cookie-blocked iframe contexts the browser still holds the previous
  // token in localStorage, so the bearer header must be rotated too.
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
 * Resolve the authenticated user: cookie first, bearer-token fallback.
 * The fallback keeps sessions alive in third-party-cookie-blocked iframe
 * contexts where the browser refuses to store/send the session cookie.
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

/** Revoke the current session — both transports (cookie + bearer token). */
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
