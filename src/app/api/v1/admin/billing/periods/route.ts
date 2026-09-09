/**
 * GET /api/v1/admin/billing/periods — billing period list (auth ADMIN).
 * Ensures the current month's OPEN period exists (never future months) and
 * returns all periods with bill counts + status.
 *
 * IMPORTANT: reading this endpoint never publishes bills. Completed periods
 * become eligible through the configured publication window, but an Admin must
 * explicitly publish after readiness passes.
 */
import { route } from "@/lib/auth/guard";
import { getInstitution } from "@/lib/institution";
import { getOrCreateOpenPeriod, listPeriods } from "@/lib/domain/billing";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "Asia/Kolkata";

  const current = await getOrCreateOpenPeriod(ctx.institutionId, tz);
  const periods = await listPeriods(ctx.institutionId);

  return {
    data: periods,
    meta: {
      currentPeriodId: current.id,
      currentPeriod: { id: current.id, year: current.year, month: current.month, status: current.status },
      automaticPublishing: false,
    },
  };
});
