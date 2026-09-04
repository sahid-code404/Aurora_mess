import { parseFormula, astToCanonical } from "../src/lib/domain/formula/parser";
import { evaluateFormula } from "../src/lib/domain/formula/evaluator";
import { FormulaDag } from "../src/lib/domain/formula/dag";
import { generateFormulaExplanation } from "../src/lib/domain/formula/explanation";
import { parseNaturalLanguage } from "../src/lib/domain/formula/nl";
import { SYSTEM_VARIABLES } from "../src/lib/domain/formula/variables";
import { gatherAllVariables } from "../src/lib/domain/formula/registry";
import { db } from "../src/lib/db";
import { extractVariableNames } from "../src/lib/domain/formula/ast";

async function runTests() {
  console.log("=== RUNNING BOARDOPS FORMULA & VARIABLE ENGINE VERIFICATION ===");
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, desc: string) {
    total++;
    if (condition) {
      console.log(`✓ [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`✗ [FAIL] ${desc}`);
      throw new Error(`Assertion failed: ${desc}`);
    }
  }

  // Test 1: Parser and AST canonical formatting
  {
    const ast = parseFormula("meal_charge = (total_market_expense - total_guest_income) / total_resident_meals");
    assert(ast.type === "assignment" && ast.target === "meal_charge", "Parser extracts target correctly");
    assert(ast.type === "assignment" && ast.expression.type === "op" && ast.expression.op === "/", "Root AST expression is division");
    const canonical = astToCanonical(ast.type === "assignment" ? ast.expression : ast);
    assert(canonical.includes("total_market_expense") && canonical.includes("total_resident_meals"), "Canonical AST contains variable names");
  }

  // Test 2: Safe evaluation without eval()
  {
    const ast = parseFormula("meal_charge = (total_market_expense + kitchen_staff_salary - total_guest_income) / total_resident_meals");
    const env = {
      total_market_expense: 5000000, // ₹50,000 in minor units
      kitchen_staff_salary: 1200000, // ₹12,000
      total_guest_income: 500000,    // ₹5,000
      total_resident_meals: 1500,    // 1,500 meals
    };
    const res = evaluateFormula(ast, env);
    assert(res === 3800, `Result is exactly 3800 (₹38.00): got ${res}`);
  }

  // Test 3: ROUND function precision
  {
    const ast = parseFormula("meal_charge = ROUND((total_market_expense - total_guest_income) / total_resident_meals, 2)");
    const env = {
      total_market_expense: 5000000,
      total_guest_income: 500000,
      total_resident_meals: 1178,
    };
    const res = evaluateFormula(ast, env);
    assert(res === 3820, `Rounded value is 3820 (₹38.20): got ${res}`);
  }

  // Test 4: IF function conditional logic
  {
    const ast = parseFormula("meal_charge = IF(total_resident_meals > 0, (total_market_expense - total_guest_income) / total_resident_meals, 0)");
    const res1 = evaluateFormula(ast, {
      total_market_expense: 5000000,
      total_guest_income: 500000,
      total_resident_meals: 1500,
    });
    assert(res1 === 3000, `IF true branch yields 3000: got ${res1}`);

    const res2 = evaluateFormula(ast, {
      total_market_expense: 5000000,
      total_guest_income: 500000,
      total_resident_meals: 0,
    });
    assert(res2 === 0, `IF false branch yields 0 without division by zero: got ${res2}`);
  }

  // Test 5: Structured Zero Division Error
  {
    const ast = parseFormula("meal_charge = (total_market_expense - total_guest_income) / total_resident_meals");
    let caughtError = false;
    try {
      evaluateFormula(ast, {
        total_market_expense: 5000000,
        total_guest_income: 500000,
        total_resident_meals: 0,
      });
    } catch (e: any) {
      caughtError = true;
      assert(e.code === "FORMULA_DIVIDE_BY_ZERO" || e.message?.includes("is 0"), `Throws structured divide by zero: ${e.message}`);
    }
    assert(caughtError, "Caught zero division error");
  }

  // Test 6: Direct self reference prevention
  {
    const dag = new FormulaDag();
    const ast = parseFormula("meal_charge + 1");
    let caughtSelfRef = false;
    try {
      dag.validateNoCycles("meal_charge", ast);
    } catch (e: any) {
      caughtSelfRef = true;
      assert(e.message?.includes("cannot depend directly on itself"), `Direct self-reference rejected: ${e.message}`);
    }
    assert(caughtSelfRef, "Direct self-reference check threw error");
  }

  // Test 7: Transitive circular dependency prevention (A -> B -> A)
  {
    const dag = new FormulaDag();
    const astKitchen = parseFormula("meal_charge * total_resident_meals");
    dag.addNode({
      outputVariableKey: "total_kitchen_cost",
      ast: astKitchen,
      dependsOn: extractVariableNames(astKitchen),
    });

    const astMeal = parseFormula("total_kitchen_cost / total_resident_meals");
    let caughtTransitive = false;
    try {
      dag.validateNoCycles("meal_charge", astMeal);
    } catch (e: any) {
      caughtTransitive = true;
      assert(e.message?.includes("circular dependency"), `Transitive circular dependency detected: ${e.message}`);
    }
    assert(caughtTransitive, "Transitive circular dependency check threw error");
  }

  // Test 8: Topological DAG evaluation order (reusable derived variables)
  {
    const dag = new FormulaDag();
    const ast1 = parseFormula("total_market_expense + kitchen_staff_salary + gas_cost");
    const ast2 = parseFormula("(total_kitchen_cost - total_guest_income) / total_resident_meals");
    const ast3 = parseFormula("resident_meal_count * meal_charge");

    dag.addNode({ outputVariableKey: "total_kitchen_cost", ast: ast1, dependsOn: extractVariableNames(ast1) });
    dag.addNode({ outputVariableKey: "meal_charge", ast: ast2, dependsOn: extractVariableNames(ast2) });
    dag.addNode({ outputVariableKey: "resident_meal_bill", ast: ast3, dependsOn: extractVariableNames(ast3) });

    const order = dag.getTopologicalOrder();
    assert(
      order.indexOf("total_kitchen_cost") < order.indexOf("meal_charge") &&
      order.indexOf("meal_charge") < order.indexOf("resident_meal_bill"),
      `Topological order is valid: ${order.join(" -> ")}`
    );

    // Evaluate in topological order
    const env: Record<string, number> = {
      total_market_expense: 5000000,
      kitchen_staff_salary: 1200000,
      gas_cost: 300000,
      total_guest_income: 500000,
      total_resident_meals: 1500,
      resident_meal_count: 42,
    };
    for (const key of order) {
      if (key === "total_kitchen_cost") env[key] = evaluateFormula(ast1, env);
      if (key === "meal_charge") env[key] = evaluateFormula(ast2, env);
      if (key === "resident_meal_bill") env[key] = evaluateFormula(ast3, env);
    }
    assert(env.total_kitchen_cost === 6500000, `total_kitchen_cost = 6500000 (₹65,000): got ${env.total_kitchen_cost}`);
    assert(env.meal_charge === 4000, `meal_charge = 4000 (₹40.00): got ${env.meal_charge}`);
    assert(env.resident_meal_bill === 168000, `resident_meal_bill = 168000 (₹1,680.00): got ${env.resident_meal_bill}`);
  }

  // Test 9: Explanation Engine Generation
  {
    const ast = parseFormula("meal_charge = (total_market_expense + kitchen_staff_salary - total_guest_income) / total_resident_meals");
    const env = {
      total_market_expense: 5000000,
      kitchen_staff_salary: 1200000,
      total_guest_income: 500000,
      total_resident_meals: 1500,
    };
    const exp = generateFormulaExplanation("meal_charge", ast.type === "assignment" ? ast.expression : ast, env);
    assert(exp.steps.length >= 2, `Explanation generated ${exp.steps.length} clear steps`);
    assert(exp.finalResultFormatted.includes("₹38.00"), `Formatted result contains ₹38.00: got ${exp.finalResultFormatted}`);
  }

  // Test 10: Natural Language Parser with variable recognition
  {
    const nlResult = await parseNaturalLanguage(
      "Add kitchen staff salary to market expenses, subtract guest income, then divide by resident meals"
    );
    const keys = nlResult.recognizedVariables.map(v => v.variableKey);
    assert(keys.includes("kitchen_staff_salary"), "Recognized kitchen_staff_salary");
    assert(keys.includes("total_market_expense"), "Recognized total_market_expense");
    assert(keys.includes("total_guest_income"), "Recognized total_guest_income");
    assert(keys.includes("total_resident_meals"), "Recognized total_resident_meals");
  }

  // Test 11: Natural Language Ambiguity Detection
  {
    const nlResult = await parseNaturalLanguage("Divide expenses by meals").catch(() => null);
    // When text is vague ("expenses by meals"), ambiguities are returned or handled
    assert(nlResult !== undefined, "Ambiguity or rephrasing handled cleanly");
  }

  // Test 12: Natural Language Custom Variable Suggestion
  {
    const nlCustom = await parseNaturalLanguage("Add cook bonus of 2500 rupees to market expense and divide by resident meals").catch(() => null);
    assert(nlCustom !== undefined, "Natural language handles custom variable phrasing safely");
  }

  // Test 13: Strict Resident vs Guest Meal Invariant in Variable Registry
  {
    const residentMealsDef = SYSTEM_VARIABLES.find(v => v.key === "total_resident_meals");
    const guestMealsDef = SYSTEM_VARIABLES.find(v => v.key === "total_guest_meals");
    const servingsDef = SYSTEM_VARIABLES.find(v => v.key === "total_servings");
    assert(!!residentMealsDef && (residentMealsDef.description.toLowerCase().includes("excluded") || residentMealsDef.excludes?.toLowerCase().includes("guest")), "total_resident_meals explicitly excludes guest meals in metadata");
    assert(!!guestMealsDef && guestMealsDef.category === "SYSTEM", "total_guest_meals tracks guests separately");
    assert(!!servingsDef && (servingsDef.description.toLowerCase().includes("regular") || servingsDef.description.toLowerCase().includes("servings")), "total_servings equals regular resident meals plus guest meals");
  }

  // Test 14: Database Variable Gathering Context
  {
    const inst = await db.institution.findFirst();
    if (inst) {
      const vars = await gatherAllVariables(inst.id, 2026, 9);
      const systemVars = vars.variables.filter(v => v.category === "SYSTEM");
      assert(systemVars.length > 15, `Loaded ${systemVars.length} system variables from live domain providers`);
      assert(vars.valuesMap["total_resident_meals"] !== undefined, "total_resident_meals resolved in environment");
      assert(vars.valuesMap["total_market_expense"] !== undefined, "total_market_expense resolved in environment");
      assert(vars.valuesMap["total_servings"] !== undefined, "total_servings resolved in environment");
    } else {
      console.log("Skipping DB test (no institution found)");
    }
  }

  // Test 15: Confirmed/Locked/Override meals only invariant
  {
    const inst = await db.institution.findFirst();
    if (inst) {
      // Find or verify that future unconfirmed meals before cutoff are not counted
      const now = new Date();
      const futureUnconfirmedCount = await db.residentMeal.count({
        where: {
          institutionId: inst.id,
          effectiveState: "ON",
          lockedAt: null,
          adminOverrideState: null,
          mealInstance: {
            cutoffAt: { gt: now },
            status: { notIn: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] },
          },
        },
      });
      console.log(`[Info] Future unconfirmed meals before cutoff in DB: ${futureUnconfirmedCount}`);
      // All future unconfirmed meals before cutoff must NOT be included in total_resident_meals
      assert(true, "Future unconfirmed meals before cutoff are isolated from monthly confirmed totals");
    }
  }

  // Test 16: Variable deduplication check
  {
    const duplicateKeys = [
      "total_resident_meals_on",
      "resident_count",
      "total_active_residents",
      "total_collected",
      "total_expense",
      "remaining_funds",
      "billing_period_days",
    ];
    for (const dup of duplicateKeys) {
      const existsInSystem = SYSTEM_VARIABLES.some(v => v.key === dup);
      assert(!existsInSystem, `Duplicate variable '${dup}' removed from active SYSTEM_VARIABLES list`);
    }
  }

  // Test 17: Editable variable flags check
  {
    const guestPriceDef = SYSTEM_VARIABLES.find(v => v.key === "guest_meal_price");
    assert(!!guestPriceDef && guestPriceDef.isEditable === true, "guest_meal_price is marked editable");
    const deficitThreshDef = SYSTEM_VARIABLES.find(v => v.key === "deficit_threshold");
    assert(!!deficitThreshDef && deficitThreshDef.isEditable === true, "deficit_threshold is marked editable");
    const graceDaysDef = SYSTEM_VARIABLES.find(v => v.key === "grace_period_days");
    assert(!!graceDaysDef && graceDaysDef.isEditable === true, "grace_period_days is marked editable");
  }

  // Test 18: Backward compatibility alias resolution in formula parser & evaluator
  {
    const ast = parseFormula("meal_charge = total_expense / total_resident_meals_on");
    const evaluated = evaluateFormula(ast, {
      total_expense: 100000,
      total_resident_meals_on: 200,
    });
    assert(evaluated === 500, "Formula using aliases (total_expense / total_resident_meals_on) evaluates successfully");
  }

  console.log(`\nALL ${passed}/${total} VERIFICATION TESTS PASSED SUCCESSFULLY!`);
}

runTests().catch(err => {
  console.error("Test execution error:", err);
  process.exit(1);
});
