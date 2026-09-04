/**
 * GET /api/v1/billing — resident's running estimate for the current period
 * (auth RESIDENT): current period state, the per-meal charge in force (formula
 * evaluated against CURRENT period numbers), my meal/guest counts, my running
 * subtotal, my credit position (available + pending payments — provenance),
 * amountToPay, and my latest bills (with lines).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { getInstitution } from "@/lib/institution";
import { formatMinor, multiplyRoundHalfUp } from "@/lib/money";
import { getOrCreateOpenPeriod, monthLabel } from "@/lib/domain/billing";
import { gatherPeriodVariables, currentPeriodBounds } from "@/lib/domain/formula/period-variables";
import { resolveFormulaVersionForPeriod } from "@/lib/domain/formula/versions";
import { FormulaAst } from "@/lib/domain/formula/ast";
import { evaluateFormula } from "@/lib/domain/formula/evaluator";
import { residentFundsSummary } from "@/lib/domain/funds";
import { serializeBill } from "@/lib/domain/serialize";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await getInstitution(ctx.institutionId);
  if (!inst) throw new ApiError(CODES.NOT_FOUND, "Institution not found.", 404);
  const tz = inst.timezone;

  const period = await getOrCreateOpenPeriod(ctx.institutionId, tz);
  const bounds = currentPeriodBounds(tz);

  // My per-resident variables + period totals.
  const variables = await gatherPeriodVariables(ctx.institutionId, bounds.year, bounds.month, ctx.user.id);

  // The formula version covering the current period (guard: may not exist yet).
  const version = await resolveFormulaVersionForPeriod(ctx.institutionId, bounds.startAt);
  let mealChargeMinor: number | null = null;
  let divideByZero = false;
  if (version) {
    try {
      mealChargeMinor = evaluateFormula(JSON.parse(version.compiledAstJson) as FormulaAst, variables);
    } catch (error) {
      if (error instanceof ApiError && error.code === CODES.FORMULA_DIVIDE_BY_ZERO) {
        divideByZero = true;
      } else {
        throw error;
      }
    }
  }

  const guestPriceMinor = inst.settings.guestMealPriceMinor;
  const myMealsCount = variables.resident_consumed_meals;
  const myGuestCount = variables.resident_guest_meals;
  const mealPart = mealChargeMinor === null ? 0 : multiplyRoundHalfUp(myMealsCount, mealChargeMinor);
  const guestPart = multiplyRoundHalfUp(myGuestCount, guestPriceMinor);
  const estimateSubtotalMinor = mealPart + guestPart;
  const estimateIncomplete = mealChargeMinor === null && myMealsCount > 0;

  const [summary, myBills] = await Promise.all([
    residentFundsSummary(ctx.user.id),
    db.bill.findMany({
      where: { residentId: ctx.user.id, status: { not: "VOIDED" } },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      take: 3,
      include: {
        period: { select: { id: true, year: true, month: true, status: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
    }),
  ]);

  const creditsMinor = summary.pendingPaymentsMinor + summary.availableMinor;

  return {
    data: {
      period: {
        year: period.year,
        month: period.month,
        monthLabel: monthLabel(period.year, period.month),
        status: period.status,
        billedAt: period.billedAt ? period.billedAt.toISOString() : null,
      },
      mealChargeMinor,
      mealChargeFormatted: mealChargeMinor === null ? null : formatMinor(mealChargeMinor),
      mealChargeSource: version
        ? {
            version: version.version,
            expressionSource: version.expressionSource,
            humanPreview: version.humanPreview,
            inputMode: version.inputMode,
          }
        : null,
      divideByZero,
      myMealsCount,
      myGuestCount,
      guestPriceMinor,
      guestPriceFormatted: formatMinor(guestPriceMinor),
      estimateSubtotalMinor,
      estimateSubtotalFormatted: formatMinor(estimateSubtotalMinor),
      estimateIncomplete,
      estimateIncompleteNote: estimateIncomplete
        ? "The per-meal charge isn't final yet — meals can't be priced until the formula can be evaluated."
        : null,
      creditsMinor,
      creditsFormatted: formatMinor(creditsMinor),
      creditsBreakdown: {
        availableMinor: summary.availableMinor,
        availableFormatted: formatMinor(summary.availableMinor),
        pendingPaymentsMinor: summary.pendingPaymentsMinor,
        pendingPaymentsFormatted: formatMinor(summary.pendingPaymentsMinor),
        chargesMinor: summary.chargesMinor,
        chargesFormatted: formatMinor(summary.chargesMinor),
        refundsIssuedMinor: summary.refundsIssuedMinor,
        carryForwardMinor: summary.carryForwardMinor,
      },
      currentAmountToPayMinor: summary.amountToPayMinor,
      currentAmountToPayFormatted: formatMinor(summary.amountToPayMinor),
      policyState: summary.policyState,
      myBills: [...myBills]
        .sort((a, b) => {
          const now = new Date();
          const isOverdue = (bill: typeof a) =>
            bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate < now);
          const isActionNeeded = (bill: typeof a) => bill.totalDueMinor > 0;

          const getRank = (bill: typeof a) => {
            if (isOverdue(bill)) return 0;
            if (isActionNeeded(bill)) return 1;
            return 2;
          };

          const rA = getRank(a);
          const rB = getRank(b);
          if (rA !== rB) return rA - rB;

          if (rA === 0 || rA === 1) {
            return a.dueDate.getTime() - b.dueDate.getTime();
          }

          return b.generatedAt.getTime() - a.generatedAt.getTime();
        })
        .map((b) => serializeBill(b)),
    },
  };
});
