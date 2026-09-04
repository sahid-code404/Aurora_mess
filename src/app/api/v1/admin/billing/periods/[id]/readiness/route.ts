/**
 * GET /api/v1/admin/billing/periods/[id]/readiness — the full readiness gate
 * (auth ADMIN, spec §53): every check with a human label + pass flag, the
 * period summary (counts, eligible expenses, approved payments, per-meal
 * charge, formula version), and the arithmetic confirmation challenge
 * {a, b} that the generate endpoint requires the client to answer (spec §55).
 */
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { computeReadiness, monthLabel } from "@/lib/domain/billing";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const period = await db.billingPeriod.findUnique({ where: { id: ctx.params.id } });
  if (!period || period.institutionId !== ctx.institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  }

  const readiness = await computeReadiness(period.id);

  // Stateless human-confirmation challenge: single digits, echoed back on generate.
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);

  return {
    data: {
      period: {
        id: period.id,
        year: period.year,
        month: period.month,
        monthLabel: monthLabel(period.year, period.month),
        status: period.status,
        billedAt: period.billedAt ? period.billedAt.toISOString() : null,
      },
      checks: readiness.checks,
      ready: readiness.ready,
      summary: {
        ...readiness.summary,
        mealChargeMinor: readiness.summary.mealChargeMinor ?? null,
        eligibleExpensesFormatted: formatMinor(readiness.summary.eligibleExpensesMinor),
        approvedPaymentsFormatted: formatMinor(readiness.summary.approvedPaymentsMinor),
        mealChargeFormatted: readiness.summary.mealChargeMinor == null || !Number.isFinite(readiness.summary.mealChargeMinor) ? null : formatMinor(readiness.summary.mealChargeMinor),
        guestPriceFormatted: formatMinor(readiness.summary.guestPriceMinor),
        guestIncomeFormatted: formatMinor(readiness.summary.guestIncomeMinor),
      },
      arithmeticChallenge: { a, b },
    },
  };
});
