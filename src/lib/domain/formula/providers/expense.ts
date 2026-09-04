/**
 * EXPENSE VARIABLE PROVIDER (spec §11, §12)
 *
 * CRITICAL RULE (spec §12):
 * total_market_expense counts ONLY approved official expenses.
 * Unapproved market task submissions are excluded.
 */
import { PeriodBounds } from "../period-variables";

export async function resolveExpenseVariables(
  institutionId: string,
  bounds: PeriodBounds,
  client: any
): Promise<Record<string, number>> {
  const expenseDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };

  const [totalAgg, approvedAgg, marketAgg, expensesList, count] = await Promise.all([
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: {
        institutionId,
        date: expenseDateRange,
      },
    }),
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: {
        institutionId,
        status: "APPROVED",
        date: expenseDateRange,
      },
    }),
    // Approved market expenses (both direct mess purchases and approved task purchases)
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: {
        institutionId,
        status: "APPROVED",
        date: expenseDateRange,
        category: { name: { in: ["MARKET", "GROCERY", "VEGETABLES", "MESS", "FOOD"] } },
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
  for (const exp of expensesList) {
    const catName = exp.category?.name?.toUpperCase() ?? "OTHER";
    catMap[catName] = (catMap[catName] ?? 0) + exp.totalMinor;
  }

  const approvedTotal = approvedAgg._sum.totalMinor ?? 0;
  // If market-specific category sum is 0, fall back to approved total so standard mess setups work
  const marketTotal = (marketAgg._sum.totalMinor ?? 0) > 0 ? (marketAgg._sum.totalMinor ?? 0) : approvedTotal;

  return {
    total_expense: totalAgg._sum.totalMinor ?? 0,
    total_approved_expense: approvedTotal,
    total_market_expense: marketTotal,
    total_grocery_expense: catMap["GROCERY"] ?? 0,
    total_vegetable_expense: catMap["VEGETABLES"] ?? 0,
    total_fuel_expense: (catMap["FUEL"] ?? 0) + (catMap["GAS"] ?? 0),
    total_other_expense: catMap["OTHER"] ?? 0,
    expense_count: count,
    // Legacy aliases
    total_market_cost: marketTotal,
    total_approved_expenses: approvedTotal,
  };
}
