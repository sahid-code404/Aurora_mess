/**
 * GET /api/v1/health/ready — readiness probe. Verifies database connectivity
 * (institution count). Returns 200 when ready, 503 envelope when not.
 */
import { NextResponse } from "next/server";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";

export const GET = route({ auth: "PUBLIC" }, async (ctx) => {
  try {
    const institutions = await db.institution.count();
    return { data: { ok: true, db: true, institutions } };
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "The service is starting up. Please try again shortly.",
          requestId: ctx.requestId,
        },
      },
      { status: 503 }
    );
  }
});
