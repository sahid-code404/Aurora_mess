"use client";
/**
 * CLIENT API helper — typed envelopes, friendly errors (client side of spec §78).
 * All requests are same-origin relative paths (Caddy gateway safe).
 *
 * SESSION TRANSPORT:
 * Normal authentication is the HttpOnly session cookie. An explicitly enabled
 * preview-only bearer fallback may return a raw token from /api/v1/auth/login
 * for cookie-blocked cross-site iframe testing. That token is kept in module
 * memory only: never localStorage, sessionStorage, IndexedDB, or any other
 * persistent browser storage. A full reload therefore clears the fallback.
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

let previewSessionToken: string | null = null;

/**
 * Hold the preview-only bearer token for this JavaScript runtime. The legacy
 * function name is kept to avoid churn at existing auth call sites; nothing is
 * persisted to browser storage.
 */
export function persistSessionToken(token: string): void {
  previewSessionToken = token;
}

/** Drop the in-memory preview bearer token (logout / session expiry). */
export function clearSessionToken(): void {
  previewSessionToken = null;
}

function storedSessionToken(): string | null {
  return previewSessionToken;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers["content-type"] = "application/json";
  }
  // Preview-only bearer fallback. In normal deployments this is always null
  // because the login endpoint does not return a raw token unless the server
  // explicitly enables preview bearer auth.
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
    // The server rejected both transports — the in-memory preview token is dead.
    clearSessionToken();
  }
  if (!body || !body.ok) {
    const err = body && !body.ok ? body.error : { code: "NETWORK", message: "Could not reach the server. Check your connection and try again.", requestId: "" };
    throw new ApiClientError(err.code, err.message, res.status, err.fields, err.requestId);
  }
  return body.data;
}

/** Login/register 401s are about the submitted credentials — never clear an existing session fallback. */
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
