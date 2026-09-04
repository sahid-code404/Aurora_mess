/**
 * GET /api/v1/admin/formulas/explain — backend explainability operation (auth ADMIN, spec §126).
 * Returns formula version, friendly expression, resolved variables, calculation steps, result, and warnings.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { FormulaAst } from "@/lib/domain/formula/ast";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import { gatherAllVariables } from "@/lib/domain/formula/registry";
import { generateFormulaExplanation } from "@/lib/domain/formula/explanation";
import { resolveFormulaVersionForPeriod } from "@/lib/domain/formula/versions";
import { toHumanPreview } from "@/lib/domain/formula/evaluator";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const outputVariable = url.searchParams.get("outputVariable") ?? "meal_charge";
  const periodParam = url.searchParams.get("period");

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = periodParam
    ? (() => {
        const [y, m] = periodParam.split("-").map(Number);
        return periodBounds(y, m, tz);
      })()
    : currentPeriodBounds(tz);

  const formulaVersion = await resolveFormulaVersionForPeriod(
    ctx.institutionId,
    bounds.startAt,
    outputVariable
  );

  if (!formulaVersion) {
    return {
      data: {
        outputVariable,
        hasFormula: false,
        message: `No active formula version covers ${bounds.periodKey}.`,
      },
    };
  }

  const ast = JSON.parse(formulaVersion.compiledAstJson) as FormulaAst;
  const registry = await gatherAllVariables(ctx.institutionId, bounds.year, bounds.month);
  const explanation = generateFormulaExplanation(outputVariable, ast, registry.valuesMap);

  return {
    data: {
      outputVariable,
      hasFormula: true,
      formulaVersion: formulaVersion.version,
      expressionSource: formulaVersion.expressionSource,
      friendlyExpression: toHumanPreview(ast),
      period: bounds.periodKey,
      explanation,
    },
  };
});
