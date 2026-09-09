/**
 * GET/POST /api/v1/cron/billing/auto-generate — compatibility endpoint.
 *
 * Automatic publication is intentionally disabled. Billing calculations remain
 * live while a period is OPEN; after the configured publication date and all
 * readiness checks pass, an Admin explicitly publishes the immutable bills.
 *
 * Security: Guarded by BILLING_CRON_SECRET or CRON_SECRET if configured.
 * Query param: ?institutionId=<id> (optional, returned only for diagnostics).
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function authorizeCron(req: NextRequest): boolean {
  const secret = process.env.BILLING_CRON_SECRET || process.env.CRON_SECRET;
  // If no secret is configured in development, allow diagnostics.
  if (!secret) return true;

  const authHeader = req.headers.get("authorization");
  const cronHeader = req.headers.get("x-cron-secret");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  return bearer === secret || cronHeader === secret;
}

async function handleCron(req: NextRequest) {
  if (!authorizeCron(req)) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid cron authorization." } },
      { status: 401 }
    );
  }

  const url = new URL(req.url);
  const institutionId = url.searchParams.get("institutionId") ?? undefined;

  return NextResponse.json({
    ok: true,
    data: {
      automaticPublishing: false,
      generated: [],
      skipped: [],
      totalGenerated: 0,
      totalSkipped: 0,
      institutionId: institutionId ?? null,
      message:
        "Automatic billing publication is disabled. Open periods keep a live preview; an Admin publishes after the configured date and readiness checks pass.",
      timestamp: new Date().toISOString(),
    },
  });
}

export async function GET(req: NextRequest) {
  return handleCron(req);
}

export async function POST(req: NextRequest) {
  return handleCron(req);
}
