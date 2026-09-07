import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  expenseCostClassLabel,
  inferLegacyExpenseCostClass,
  isExpenseCostClass,
} from "@/lib/domain/expense-cost-class";
import { SYSTEM_VARIABLES_MAP } from "@/lib/domain/formula/variables";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("expense cost classification", () => {
  test("classification vocabulary is closed and user-facing labels are stable", () => {
    expect(isExpenseCostClass("MEAL_COST")).toBe(true);
    expect(isExpenseCostClass("EXTRA_COST")).toBe(true);
    expect(isExpenseCostClass("MARKET")).toBe(false);
    expect(expenseCostClassLabel("MEAL_COST")).toBe("Meal Cost");
    expect(expenseCostClassLabel("EXTRA_COST")).toBe("Extra Cost");
  });

  test("legacy requests preserve old market semantics while unknown overhead fails to extra", () => {
    expect(inferLegacyExpenseCostClass("Grocery")).toBe("MEAL_COST");
    expect(inferLegacyExpenseCostClass("Vegetables")).toBe("MEAL_COST");
    expect(inferLegacyExpenseCostClass("Gas")).toBe("MEAL_COST");
    expect(inferLegacyExpenseCostClass("Maintenance")).toBe("EXTRA_COST");
    expect(inferLegacyExpenseCostClass(null)).toBe("EXTRA_COST");
    expect(inferLegacyExpenseCostClass("Maintenance", "TASK")).toBe("MEAL_COST");
  });

  test("Formula Engine exposes first-class meal and extra expense variables", () => {
    expect(SYSTEM_VARIABLES_MAP.total_meal_expense?.valueType).toBe("MONEY");
    expect(SYSTEM_VARIABLES_MAP.total_extra_expense?.valueType).toBe("MONEY");
    expect(SYSTEM_VARIABLES_MAP.total_market_expense?.description).toContain("Compatibility");
  });

  test("formula expense provider allocates by classification, not category name", () => {
    const text = source("src/lib/domain/formula/providers/expense.ts");
    expect(text).toContain('costClass: "MEAL_COST"');
    expect(text).toContain('costClass: "EXTRA_COST"');
    expect(text).toContain("total_meal_expense: mealTotal");
    expect(text).toContain("total_extra_expense: extraTotal");
    expect(text).toContain("total_market_expense: mealTotal");
    expect(text).not.toContain("marketSpecific > 0");
  });

  test("direct expenses persist classification and expose classified monthly totals", () => {
    const text = source("src/app/api/v1/admin/expenses/route.ts");
    expect(text).toContain('formText(form, "costClass")');
    expect(text).toContain("costClass,");
    expect(text).toContain('costClass: "MEAL_COST"');
    expect(text).toContain('costClass: "EXTRA_COST"');
    expect(text).toContain("mealExpensesThisMonthFormatted");
    expect(text).toContain("extraExpensesThisMonthFormatted");
  });

  test("market task approval always creates a Meal Cost expense", () => {
    const text = source("src/app/api/v1/admin/task-submissions/[id]/approve/route.ts");
    expect(text).toContain('source: "TASK"');
    expect(text).toContain('costClass: "MEAL_COST"');
    expect(text).toContain("includedInMealCharge: true");
  });

  test("reclassification is audited, billing-serialized, and cannot rewrite frozen months", () => {
    const text = source("src/app/api/v1/admin/expenses/[id]/classification/route.ts");
    expect(text).toContain("lockInstitutionFinancialMutation");
    expect(text).toContain("assertExpensePeriodMutable");
    expect(text).toContain('action: "EXPENSE_RECLASSIFIED"');
    expect(text).toContain('expense.source === "TASK"');
  });

  test("billing readiness exposes the exact classified variables used by formulas", () => {
    const text = source("src/app/api/v1/admin/billing/periods/[id]/readiness/route.ts");
    expect(text).toContain("readiness.variables.total_meal_expense");
    expect(text).toContain("readiness.variables.total_extra_expense");
    expect(text).toContain("mealExpensesFormatted");
    expect(text).toContain("extraExpensesFormatted");
    expect(text).toContain("totalApprovedExpensesFormatted");
  });

  test("migration backfills historical semantics and constrains the new field", () => {
    const text = source("prisma/migrations/20260908_000000_expense_cost_classification/migration.sql");
    expect(text).toContain("ADD COLUMN \"costClass\"");
    expect(text).toContain("UPPER(TRIM(c.\"name\"))");
    expect(text).toContain("'MEAL_COST'");
    expect(text).toContain("'EXTRA_COST'");
    expect(text).toContain("Expense_costClass_check");
  });
});
