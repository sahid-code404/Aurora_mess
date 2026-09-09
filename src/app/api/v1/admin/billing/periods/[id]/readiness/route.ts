/**
 * GET /api/v1/admin/billing/periods/[id]/readiness — live billing preview and
 * publication readiness (auth ADMIN).
 *
 * While the period is OPEN this endpoint always resolves the current source
 * data through the Variable + Formula engines. Publication is a separate gate:
 * the month must have ended, the configured publication day must have arrived,
 * and every financial/data readiness check must pass.
 */
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { computeReadiness, monthLabel } from "@/lib/domain/billing";
import {
  formatBillingPublishDate,
  getBillingPublicationWindowForPeriod,
  ordinalDay,
} from "@/lib/domain/billing-publication";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const period = await db.billingPeriod.findUnique({ where: { id: ctx.params.id } });
  if (!period || period.institutionId !== ctx.institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  }

  const [readiness, publication] = await Promise.all([
    computeReadiness(period.id),
    getBillingPublicationWindowForPeriod(period.id),
  ]);

  // Replace the old hard-coded auto-generation wording with the real live
  // lifecycle and add the independently configurable publication window.
  const checks = readiness.checks.map((check) =>
    check.key === "month_ended"
      ? {
          ...check,
          key: "billing_month_closed",
          label: publication.monthEnded ? "Billing month has ended" : "Billing month is still live",
          detail: publication.monthEnded
            ? "The month has ended. The preview remains live until Admin publication."
            : "This preview keeps recalculating as meals, expenses, payments and formula inputs change.",
        }
      : check
  );

  const publishAtFormatted = formatBillingPublishDate(publication.publishAt, publication.timeZone);
  checks.push({
    key: "publish_window_open",
    label: publication.windowOpen ? "Publication window is open" : "Waiting for publication date",
    pass: publication.windowOpen,
    detail: publication.windowOpen
      ? `The configured ${ordinalDay(publication.publishDay)}-day publication gate has been reached. Admin publication is allowed after all other checks pass.`
      : `Admin publication opens on ${publishAtFormatted} (${ordinalDay(publication.publishDay)} of the next month). The live preview continues updating until then.`,
  });

  // These come from the exact same period-variable snapshot used by the active
  // formula. Do not rebuild them independently in the read model.
  const mealExpensesMinor = readiness.variables.total_meal_expense ?? readiness.variables.total_market_expense ?? 0;
  const extraExpensesMinor = readiness.variables.total_extra_expense ?? 0;
  const totalApprovedExpensesMinor =
    readiness.variables.total_approved_expense ?? mealExpensesMinor + extraExpensesMinor;

  // Stateless human-confirmation challenge: single digits, echoed back on publish.
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const ready = checks.every((check) => check.pass);

  const publicationMessage =
    period.status === "BILLED" || period.status === "REOPENED"
      ? "Published billing is frozen. Later payments and refunds update settlement without rewriting the bill calculation."
      : publication.state === "LIVE"
        ? "Live preview — source-data and formula changes recalculate this billing view."
        : publication.state === "WAITING"
          ? `Month ended — preview stays live until Admin publication opens on ${publishAtFormatted}.`
          : ready
            ? "Ready to publish — all checks passed. Admin confirmation will freeze the billing snapshot."
            : "Publication date reached — resolve the remaining readiness checks before publishing.";

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
      publication: {
        state: publication.state,
        publishDay: publication.publishDay,
        publishAt: publication.publishAt.toISOString(),
        publishAtFormatted,
        monthEnded: publication.monthEnded,
        windowOpen: publication.windowOpen,
        automaticPublishing: false,
        message: publicationMessage,
      },
      checks,
      ready,
      summary: {
        ...readiness.summary,
        mealChargeMinor: readiness.summary.mealChargeMinor ?? null,
        // Existing Billing UI reads eligibleExpensesFormatted. Make that visual
        // value match the expense pool actually consumed by the meal formula.
        // The raw legacy eligibleExpensesMinor field remains untouched for API
        // compatibility and historical snapshot integrity.
        eligibleExpensesFormatted: formatMinor(mealExpensesMinor),
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
