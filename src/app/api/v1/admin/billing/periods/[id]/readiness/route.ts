/**
 * GET /api/v1/admin/billing/periods/[id]/readiness — the full readiness gate
 * (auth ADMIN, spec §53): every check with a human label + pass flag, the
 * period summary (counts, expense classifications, approved payments, per-meal
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

  // These come from the exact same period-variable snapshot used by the active
  // formula. Do not rebuild them independently in the read model.
  const mealExpensesMinor = readiness.variables.total_meal_expense ?? readiness.variables.total_market_expense ?? 0;
  const extraExpensesMinor = readiness.variables.total_extra_expense ?? 0;
  const totalApprovedExpensesMinor =
    readiness.variables.total_approved_expense ?? mealExpensesMinor + extraExpensesMinor;

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
        // Backward-compatible field remains the old all-approved read-model
        // amount. New UI uses the explicit classified amounts below.
        eligibleExpensesFormatted: formatMinor(readiness.summary.eligibleExpensesMinor),
        mealExpensesMinor,
        mealExpensesFormatted: formatMinor(mealExpensesMinor),
        extraExpensesMinor,
        extraExpensesFormatted: formatMinor(extraExpensesMinor),
        totalApprovedExpensesMinor,
        totalApprovedExpensesFormatted: formatMinor(totalApprovedExpensesMinor),
        approvedPaymentsFormatted: formatMinor(readiness.summary.approvedPaymentsMinor),
        mealChargeFormatted:
          readiness.summary.mealChargeMinor == null || !Number.isFinite(readiness.summary.mealChargeMinor)
            ? null
            : formatMinor(readiness.summary.mealChargeMinor),
        guestPriceFormatted: formatMinor(readiness.summary.guestPriceMinor),
        guestIncomeFormatted: formatMinor(readiness.summary.guestIncomeMinor),
      },
      arithmeticChallenge: { a, b },
    },
  };
});