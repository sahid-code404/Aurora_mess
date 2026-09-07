export const EXPENSE_COST_CLASSES = ["MEAL_COST", "EXTRA_COST"] as const;

export type ExpenseCostClass = (typeof EXPENSE_COST_CLASSES)[number];

const LEGACY_MEAL_CATEGORIES = new Set([
  "MARKET",
  "GROCERY",
  "VEGETABLES",
  "MESS",
  "FOOD",
  "FUEL",
  "GAS",
]);

export function isExpenseCostClass(value: unknown): value is ExpenseCostClass {
  return typeof value === "string" && (EXPENSE_COST_CLASSES as readonly string[]).includes(value);
}

/**
 * Compatibility only for older clients that do not submit costClass yet.
 * New UI flows require an explicit choice. The fallback intentionally mirrors
 * the migration so legacy requests never change historical billing semantics.
 */
export function inferLegacyExpenseCostClass(
  categoryName: string | null | undefined,
  source: "DIRECT" | "TASK" = "DIRECT"
): ExpenseCostClass {
  if (source === "TASK") return "MEAL_COST";
  const normalized = categoryName?.trim().toUpperCase() ?? "";
  return LEGACY_MEAL_CATEGORIES.has(normalized) ? "MEAL_COST" : "EXTRA_COST";
}

export function expenseCostClassLabel(costClass: string): string {
  return costClass === "MEAL_COST" ? "Meal Cost" : "Extra Cost";
}
