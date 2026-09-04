/**
 * GUARD + route handler wrapper — the single authorization chokepoint (spec §8, §217).
 * Every /api/v1 route goes through `route()`: resolves params, enforces auth+role,
 * injects requestId + user context, and converts ApiError into the standard envelope.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { ApiError, CODES, fail, newRequestId, ok } from "@/lib/errors";

export type HandlerCtx = {
  req: NextRequest;
  params: Record<string, string>;
  user: SessionUser; // present when auth !== "PUBLIC"
  institutionId: string;
  requestId: string;
};

type AuthMode = "PUBLIC" | "ANY" | "ADMIN" | "RESIDENT";

type RouteResult = { data: unknown; meta?: Record<string, unknown> } | NextResponse;

export function route(
  opts: { auth: AuthMode },
  fn: (ctx: HandlerCtx) => Promise<RouteResult>
): (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => Promise<Response> {
  return async (req, routeCtx) => {
    const requestId = newRequestId();
    try {
      let params: Record<string, string> = {};
      if (routeCtx?.params) params = await routeCtx.params;
      let user: SessionUser | null = null;
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
      if (result instanceof NextResponse) return result;
      return ok(result.data, result.meta, requestId);
    } catch (error) {
      return fail(error, requestId);
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
