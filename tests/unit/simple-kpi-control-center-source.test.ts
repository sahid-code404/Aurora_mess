import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BUILTIN_KPI_CATALOG } from "@/lib/domain/formula/kpi-catalog";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("simple KPI control center", () => {
  test("important money and billing KPIs point to registry sources instead of duplicating arithmetic", () => {
    const sources = new Set(BUILTIN_KPI_CATALOG.map((item) => item.sourceKey));
    for (const expected of [
      "available_funds",
      "meal_charge",
      "total_meal_expense",
      "total_extra_expense",
      "total_approved_expense",
      "total_guest_income",
      "total_resident_meals",
      "total_payments_approved",
      "total_refunds",
      "total_carry_forward",
      "total_credit_balance",
      "total_outstanding_balance",
    ]) {
      expect(sources.has(expected)).toBe(true);
    }
  });

  test("KPI route resolves through the existing registry and exposes all extra formula outputs automatically", () => {
    const route = source("src/app/api/v1/admin/formulas/kpis/route.ts");
    expect(route).toContain("gatherAllVariables(ctx.institutionId");
    expect(route).toContain("selectFormulaVersionAt");
    expect(route).toContain("Every additional FormulaDefinition automatically becomes a visible custom");
    expect(route).toContain('control === "SYSTEM"');
    expect(route).not.toContain("eval(");
    expect(route).not.toContain("new Function");
  });

  test("formula KPI edit creates a new audited current-open version and invalidates live readers", () => {
    const ui = source("src/components/app/admin/formula-kpi-center.tsx");
    expect(ui).toContain('effective: "CURRENT_OPEN"');
    expect(ui).toContain("confirmImpact: true");
    expect(ui).toContain('reason: reason.trim()');
    expect(ui).toContain('"/api/v1/admin/dashboard"');
    expect(ui).toContain('"/api/v1/admin/billing"');
    expect(ui).toContain('"/api/v1/admin/expenses"');
    expect(ui).toContain('"/api/v1/admin/funds"');
    expect(ui).toContain("Generated bills stay frozen");
  });

  test("default formulas page is simple while retaining the proven advanced workbench", () => {
    const page = source("src/components/app/admin/formulas.tsx");
    expect(page).toContain("FormulaKpiCenter");
    expect(page).toContain("FormulaWorkbench");
    expect(page).toContain("Open formulas & variables");
    expect(page).toContain("showWorkbench && <FormulaWorkbench />");
  });
});
