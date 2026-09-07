/**
 * EXPENSE VARIABLE PROVIDER (spec §11, §12)
 *
 * Billing semantics are driven by Expense.costClass, never by display category
 * names. Categories remain useful reporting labels; costClass is the stable
 * accounting/billing classification:
 *   MEAL_COST  — participates in the resident per-meal charge pool.
 *   EXTRA_COST — real approved cash expense, excluded from meal-charge by default.
 *
 * total_market_expense is retained as a compatibility alias for older active
 * formulas, but now resolves to the authoritative classified meal-cost total.
 */
import { PeriodBounds } from "../period-variables";

const SPECIFIC_CATEGORIES = new Set(["MARKET", "GROCERY", "VEGETABLES", "MESS", "FOOD", "FUEL", "GAS"]);

export async function resolveExpenseVariables(
  institutionId: string,
  bounds: PeriodBounds,
  client: any
): Promise<Record<string, number>> {
  const expenseDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };
  const approvedWhere = {
    institutionId,
    status: "APPROVED",
    date: expenseDateRange,
  };

  const [approvedAgg, mealAgg, extraAgg, expensesList, count] = await Promise.all([
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: approvedWhere,
    }),
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: { ...approvedWhere, costClass: "MEAL_COST" },
    }),
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: { ...approvedWhere, costClass: "EXTRA_COST" },
    }),
    client.expense.findMany({
      where: approvedWhere,
      select: {
        totalMinor: true,
        category: { select: { name: true } },
      },
    }),
    client.expense.count({ where: approvedWhere }),
  ]);

  const catMap: Record<string, number> = {};
  let otherTotal = 0;
  for (const exp of expensesList) {
    const catName = exp.category?.name?.toUpperCase() ?? "OTHER";
    catMap[catName] = (catMap[catName] ?? 0) + exp.totalMinor;
    if (!SPECIFIC_CATEGORIES.has(catName)) otherTotal += exp.totalMinor;
  }

  const approvedTotal = approvedAgg._sum.totalMinor ?? 0;
  const mealTotal = mealAgg._sum.totalMinor ?? 0;
  const extraTotal = extraAgg._sum.totalMinor ?? 0;

  return {
    // All approved expenses are still authoritative cash expenses.
    total_expense: approvedTotal,
    total_approved_expense: approvedTotal,

    // Billing allocation semantics.
    total_meal_expense: mealTotal,
    total_extra_expense: extraTotal,

    // Compatibility: existing active formulas using total_market_expense keep
    // working, but now use the explicit MEAL_COST classification instead of a
    // fragile category-name heuristic.
    total_market_expense: mealTotal,

    // Reporting-only category breakdowns remain independent of costClass.
    total_grocery_expense: catMap["GROCERY"] ?? 0,
    total_vegetable_expense: catMap["VEGETABLES"] ?? 0,
    total_fuel_expense: (catMap["FUEL"] ?? 0) + (catMap["GAS"] ?? 0),
    total_other_expense: otherTotal,
    expense_count: count,

    // Legacy aliases.
    total_market_cost: mealTotal,
    total_approved_expenses: approvedTotal,
  };
}
