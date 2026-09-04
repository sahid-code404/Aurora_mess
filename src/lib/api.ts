"use client";
/**
 * CLIENT API helper — typed envelopes, friendly errors (client side of spec §78).
 * All requests are same-origin relative paths (Caddy gateway safe).
 *
 * SESSION TRANSPORT FALLBACK: browsers may refuse the session cookie when the
 * app runs inside the sandbox preview panel's cross-site iframe (third-party
 * cookie blocking). After a successful login the raw session token returned
 * by /api/v1/auth/login is persisted here and attached as an
 * `Authorization: Bearer` header on every call. The server prefers the cookie
 * and falls back to the header, so sign-in works in every context.
 */

export type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: { requestId?: string } & Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; fields?: Record<string, string>; requestId: string } };

export class ApiClientError extends Error {
  code: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
  constructor(code: string, message: string, status: number, fields?: Record<string, string>, requestId?: string) {
    super(message);
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
    this.status = status;
  }
}

const SESSION_TOKEN_KEY = "mes_session_token";

/** Persist the login session token (Bearer fallback transport). */
export function persistSessionToken(token: string): void {
  try {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) — cookie transport still applies */
  }
}

/** Drop the persisted session token (logout / session expiry). */
export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function storedSessionToken(): string | null {
  try {
    return window.localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers["content-type"] = "application/json";
  }
  // Bearer fallback: attach the persisted session token when the cookie
  // transport may be blocked (preview iframe). Harmless when both exist.
  const sessionToken = typeof window !== "undefined" ? storedSessionToken() : null;
  if (sessionToken) {
    headers["authorization"] = `Bearer ${sessionToken}`;
  }
  const res = await fetch(path, {
    ...rest,
    headers: { ...(rest.headers as Record<string, string> | undefined), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401 && typeof window !== "undefined" && !isCredentialEntry(path)) {
    // The server rejected both transports — the stored token is dead.
    clearSessionToken();
  }
  if (!body || !body.ok) {
    const err = body && !body.ok ? body.error : { code: "NETWORK", message: "Could not reach the server. Check your connection and try again.", requestId: "" };
    throw new ApiClientError(err.code, err.message, res.status, err.fields, err.requestId);
  }
  return body.data;
}

/** Login/register 401s are about the submitted credentials — never nuke the stored token. */
function isCredentialEntry(path: string): boolean {
  return path.startsWith("/api/v1/auth/login") || path.startsWith("/api/v1/auth/register");
}

/** GET with query params helper. */
export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return api<T>(url.pathname + url.search);
}
