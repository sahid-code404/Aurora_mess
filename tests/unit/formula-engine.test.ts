import { describe, expect, test } from "bun:test";

import { ApiError, CODES } from "../../src/lib/errors";
import { FormulaDag } from "../../src/lib/domain/formula/dag";
import { evaluateFormula } from "../../src/lib/domain/formula/evaluator";
import { astToCanonical, parseFormula } from "../../src/lib/domain/formula/parser";

describe("formula engine regression invariants", () => {
  const allowed = new Set([
    "meal_charge",
    "total_market_expense",
    "total_guest_income",
    "total_resident_meals",
    "a",
    "b",
    "c",
  ]);

  test("parses and evaluates the canonical meal charge formula", () => {
    const ast = parseFormula(
      "meal_charge = (total_market_expense - total_guest_income) / total_resident_meals",
      allowed
    );

    expect(astToCanonical(ast)).toBe(
      "meal_charge = (total_market_expense - total_guest_income) / total_resident_meals"
    );

    expect(
      evaluateFormula(ast, {
        total_market_expense: 9_000_000,
        total_guest_income: 500_000,
        total_resident_meals: 1_000,
      })
    ).toBe(8_500);
  });

  test("fails explicitly when a denominator is zero", () => {
    const ast = parseFormula(
      "meal_charge = total_market_expense / total_resident_meals",
      allowed
    );

    try {
      evaluateFormula(ast, {
        total_market_expense: 9_000_000,
        total_resident_meals: 0,
      });
      throw new Error("expected formula evaluation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(CODES.FORMULA_DIVIDE_BY_ZERO);
    }
  });

  test("rejects variables outside the registered variable set", () => {
    try {
      parseFormula("meal_charge = unknown_cost / total_resident_meals", allowed);
      throw new Error("expected formula parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(CODES.FORMULA_UNKNOWN_VARIABLE);
    }
  });

  test("detects direct self-reference", () => {
    const dag = new FormulaDag();
    const candidate = parseFormula("a = a + b", allowed);

    expect(() => dag.validateNoCycles("a", candidate)).toThrow();
  });

  test("detects indirect circular dependencies", () => {
    const dag = new FormulaDag();
    dag.addNode({
      outputVariableKey: "b",
      ast: parseFormula("b = a + c", allowed),
      dependsOn: ["a", "c"],
    });

    const candidate = parseFormula("a = b + c", allowed);
    expect(() => dag.validateNoCycles("a", candidate)).toThrow();
  });

  test("orders derived formulas after their derived dependencies", () => {
    const dag = new FormulaDag();
    dag.addNode({
      outputVariableKey: "a",
      ast: parseFormula("a = c", allowed),
      dependsOn: ["c"],
    });
    dag.addNode({
      outputVariableKey: "b",
      ast: parseFormula("b = a + c", allowed),
      dependsOn: ["a", "c"],
    });

    const order = dag.getTopologicalOrder();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });
});
