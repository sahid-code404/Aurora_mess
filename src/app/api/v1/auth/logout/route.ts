/**
 * POST /api/v1/auth/logout — revoke the current session and clear the cookie.
 */
import { route } from "@/lib/auth/guard";
import { ok } from "@/lib/errors";
import { revokeSession } from "@/lib/auth/session";

export const POST = route({ auth: "ANY" }, async (ctx) => {
  const res = ok({ signedOut: true }, undefined, ctx.requestId);
  await revokeSession(ctx.req, res);
  return res;
});
