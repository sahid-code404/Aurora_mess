/**
 * GUARD + route handler wrapper — the single authorization chokepoint (spec §8, §217).
 * Every /api/v1 route goes through `route()`: resolves params, enforces auth+role,
 * blocks cross-site cookie-forged mutations, injects requestId + user context,
 * and converts ApiError into the standard envelope.
 */
import { NextResponse, type NextRequest } from "next/server";
import { bearerToken, getSessionUser, type SessionUser } from "@/lib/auth/session";
import { ApiError, CODES, fail, newRequestId, ok } from "@/lib/errors";
import { logApiRequest } from "@/lib/observability";

export type HandlerCtx = {
  req: NextRequest;
  params: Record<string, string>;
  user: SessionUser; // present when auth !== "PUBLIC"
  institutionId: string;
  requestId: string;
};

type AuthMode = "PUBLIC" | "ANY" | "ADMIN" | "RESIDENT";

type RouteResult = { data: unknown; meta?: Record<string, unknown> } | NextResponse;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  return first || null;
}

/**
 * Resolve the externally visible origin of this HTTP request.
 *
 * `NextRequest.url` can describe the internal standalone listener rather than
 * the browser-facing origin after a reverse proxy. Host, however, is the
 * destination the browser actually addressed; Caddy preserves that Host and
 * supplies X-Forwarded-Proto for TLS termination. Using those request-facing
 * headers prevents legitimate same-origin mutations from being rejected while
 * still comparing attacker Origin/Referer values against the destination host.
 */
function requestOrigin(req: NextRequest): string {
  const internal = new URL(req.url);
  const host = req.headers.get("host")?.trim();
  if (!host) return internal.origin;

  const forwardedProto = firstForwardedValue(req.headers.get("x-forwarded-proto"))?.toLowerCase();
  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : internal.protocol.replace(/:$/, "");

  return originOf(`${protocol}://${host}`) ?? internal.origin;
}

/**
 * CSRF guard for cookie-authenticated mutations.
 *
 * - Safe/read methods are unaffected.
 * - Explicit preview bearer requests are not ambient credentials, so they do
 *   not need CSRF protection; an attacker cannot cause a browser to attach the
 *   secret Authorization header cross-site.
 * - Cookie-backed mutation requests must not be browser-classified cross-site.
 * - Origin/Referer, when present, must match the request-facing API origin.
 *
 * Modern browsers send Sec-Fetch-Site and/or Origin for cross-site mutation
 * requests. We intentionally do not require those headers to exist so trusted
 * non-browser tooling can still call cookie-authenticated endpoints, but any
 * supplied cross-site evidence fails closed.
 */
export function assertCsrfSafeRequest(req: NextRequest): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  if (bearerToken(req)) return;

  const expectedOrigin = requestOrigin(req);
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    throw new ApiError(CODES.FORBIDDEN, "Cross-site requests are not allowed for this action.", 403);
  }

  const origin = req.headers.get("origin");
  if (origin && originOf(origin) !== expectedOrigin) {
    throw new ApiError(CODES.FORBIDDEN, "Cross-site requests are not allowed for this action.", 403);
  }

  const referer = req.headers.get("referer");
  if (!origin && referer && originOf(referer) !== expectedOrigin) {
    throw new ApiError(CODES.FORBIDDEN, "Cross-site requests are not allowed for this action.", 403);
  }
}

export function route(
  opts: { auth: AuthMode },
  fn: (ctx: HandlerCtx) => Promise<RouteResult>
): (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => Promise<Response> {
  return async (req, routeCtx) => {
    const requestId = newRequestId();
    const startedAt = Date.now();
    let user: SessionUser | null = null;

    const finish = (response: NextResponse, errorCode?: string): NextResponse => {
      response.headers.set("x-request-id", requestId);
      logApiRequest({
        requestId,
        method: req.method.toUpperCase(),
        path: req.nextUrl.pathname,
        status: response.status,
        durationMs: Math.max(0, Date.now() - startedAt),
        authMode: opts.auth,
        actorUserId: user?.id,
        actorRole: user?.role,
        institutionId: user?.institutionId,
        errorCode,
      });
      return response;
    };

    try {
      assertCsrfSafeRequest(req);

      let params: Record<string, string> = {};
      if (routeCtx?.params) params = await routeCtx.params;
      if (opts.auth !== "PUBLIC") {
        user = await getSessionUser(req);
        if (!user) throw new ApiError(CODES.UNAUTHENTICATED, "Please sign in to continue.", 401);
        if (opts.auth === "ADMIN" && user.role !== "ADMIN")
          throw new ApiError(CODES.FORBIDDEN, "You do not have access to this action.", 403);
        if (opts.auth === "RESIDENT" && user.role !== "RESIDENT")
          throw new ApiError(CODES.FORBIDDEN, "This action is only available to residents.", 403);
      }
      const result = await fn({
        req,
        params,
        user: user as SessionUser,
        institutionId: user?.institutionId ?? "public",
        requestId,
      });
      if (result instanceof NextResponse) return finish(result);
      return finish(ok(result.data, result.meta, requestId));
    } catch (error) {
      const response = fail(error, requestId);
      const errorCode = error instanceof ApiError ? error.code : CODES.INTERNAL;
      return finish(response, errorCode);
    }
  };
}

/** Parse + validate a JSON body via a zod schema with a friendly error. */
export async function parseBody<T>(
  req: NextRequest,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number | symbol)[]; message: string }[] } } }
): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(CODES.VALIDATION_FAILED, "The request could not be read as JSON.", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "form";
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, fields);
  }
  return parsed.data;
}

/** Ownership check helper — residents may only touch their own rows (spec §217). */
export function assertOwnership(user: SessionUser, ownerResidentId: string): void {
  if (user.role === "RESIDENT" && user.id !== ownerResidentId) {
    throw new ApiError(CODES.FORBIDDEN, "You do not have access to this record.", 403);
  }
}
