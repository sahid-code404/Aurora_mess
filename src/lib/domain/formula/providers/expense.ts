/**
 * EXPENSE VARIABLE PROVIDER (spec §11, §12)
 *
 * CRITICAL RULE (spec §12):
 * total_market_expense counts ONLY approved official market-related expenses.
 * Unapproved market task submissions and unrelated approved costs are excluded.
 */
import { PeriodBounds } from "../period-variables";

const MARKET_CATEGORIES = new Set(["MARKET", "GROCERY", "VEGETABLES", "MESS", "FOOD"]);
const SPECIFIC_CATEGORIES = new Set([...MARKET_CATEGORIES, "FUEL", "GAS"]);

export async function resolveExpenseVariables(
  institutionId: string,
  bounds: PeriodBounds,
  client: any
): Promise<Record<string, number>> {
  const expenseDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };

  const [approvedAgg, marketAgg, expensesList, count] = await Promise.all([
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: {
        institutionId,
        status: "APPROVED",
        date: expenseDateRange,
      },
    }),
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: {
        institutionId,
        status: "APPROVED",
        date: expenseDateRange,
        category: { name: { in: [...MARKET_CATEGORIES] } },
      },
    }),
    client.expense.findMany({
      where: {
        institutionId,
        status: "APPROVED",
        date: expenseDateRange,
      },
      select: {
        totalMinor: true,
        category: { select: { name: true } },
      },
    }),
    client.expense.count({
      where: {
        institutionId,
        status: "APPROVED",
        date: expenseDateRange,
      },
    }),
  ]);

  const catMap: Record<string, number> = {};
  let otherTotal = 0;
  for (const exp of expensesList) {
    const catName = exp.category?.name?.toUpperCase() ?? "OTHER";
    catMap[catName] = (catMap[catName] ?? 0) + exp.totalMinor;
    if (!SPECIFIC_CATEGORIES.has(catName)) otherTotal += exp.totalMinor;
  }

  const approvedTotal = approvedAgg._sum.totalMinor ?? 0;
  const marketTotal = marketAgg._sum.totalMinor ?? 0;

  return {
    // Legacy total_expense is kept aligned with the authoritative approved total.
    total_expense: approvedTotal,
    total_approved_expense: approvedTotal,
    total_market_expense: marketTotal,
    total_grocery_expense: catMap["GROCERY"] ?? 0,
    total_vegetable_expense: catMap["VEGETABLES"] ?? 0,
    total_fuel_expense: (catMap["FUEL"] ?? 0) + (catMap["GAS"] ?? 0),
    total_other_expense: otherTotal,
    expense_count: count,
    // Legacy aliases
    total_market_cost: marketTotal,
    total_approved_expenses: approvedTotal,
  };
}
