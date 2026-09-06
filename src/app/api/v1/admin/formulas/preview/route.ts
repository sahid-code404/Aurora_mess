/**
 * POST /api/v1/admin/formulas/preview — live test & explainability preview (auth ADMIN).
 * Evaluates candidate formula against real period data without mutating anything.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { getInstitution } from "@/lib/institution";
import { evaluateFormulaWithSteps, toHumanPreview } from "@/lib/domain/formula/evaluator";
import { astToCanonical, formatFormulaExpression } from "@/lib/domain/formula/parser";
import { parseFormulaSource } from "@/lib/domain/formula/versions";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import { gatherAllVariables } from "@/lib/domain/formula/registry";
import { generateFormulaExplanation } from "@/lib/domain/formula/explanation";
import { FormulaDag } from "@/lib/domain/formula/dag";
import { selectFormulaVersionAt } from "@/lib/domain/formula/effective-version";
import { db } from "@/lib/db";
import { formatMinor } from "@/lib/money";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mode: z.enum(["FORMULA", "NATURAL_LANGUAGE"]),
  source: z.string().min(1, "Describe the formula or enter formula text.").max(2500),
  outputVariableKey: z.string().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM").optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const rl = await rateLimit(clientKey(ctx.req, "formula-preview"), 40, 5 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      `Too many previews — try again in ${rl.retryAfterSec} seconds.`,
      429
    );
  }
  const body = await parseBody(ctx.req, bodySchema);

  // 1. Parse & validate source (FORMULA or NATURAL_LANGUAGE)
  const { ast, formulaText, naturalSource, recognized, ambiguities, suggestedVar } =
    await parseFormulaSource(body.mode, body.source);

  const outputKey = (ast.type === "assignment" ? ast.target : body.outputVariableKey ?? "meal_charge").trim();

  // 2. Resolve period bounds & variables
  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = body.period
    ? (() => {
        const [y, m] = body.period.split("-").map(Number);
        return periodBounds(y, m, tz);
      })()
    : currentPeriodBounds(tz);

  const registry = await gatherAllVariables(ctx.institutionId, bounds.year, bounds.month);
  const variables = registry.valuesMap;

  // 3. Evaluate AST with sub-computation steps
  let value = 0;
  let steps: string[] = [];
  let divideByZero = false;
  let divideByZeroMessage: string | null = null;

  try {
    const evalRes = evaluateFormulaWithSteps(ast, variables);
    value = evalRes.value;
    steps = evalRes.steps;
  } catch (error) {
    if (error instanceof ApiError && error.code === CODES.FORMULA_DIVIDE_BY_ZERO) {
      divideByZero = true;
      divideByZeroMessage = error.message;
    } else {
      throw error;
    }
  }

  // 4. Per-meal breakdown
  const meals = variables.total_resident_meals ?? variables.total_consumed_resident_meals ?? 0;
  const perMeal = meals > 0 && !divideByZero ? Math.round(value / meals) : null;
  const isNegative = !divideByZero && value < 0;

  // 5. Generate human narrative explanation
  const explanation = generateFormulaExplanation(outputKey, ast, variables);

  // 6. Check downstream impact
  const allDefs = await db.formulaDefinition.findMany({
    where: { institutionId: ctx.institutionId },
    include: {
      versions: { orderBy: { version: "desc" }, include: { dependencies: true } },
    },
  });
  const dag = new FormulaDag();
  for (const d of allDefs) {
    const periodVersion = selectFormulaVersionAt(d.versions, bounds.startAt);
    if (!periodVersion) continue;
    try {
      dag.addNode({
        outputVariableKey: d.outputVariableKey,
        name: d.name,
        ast: JSON.parse(periodVersion.compiledAstJson),
        dependsOn: periodVersion.dependencies.map((dep) => dep.variableKey),
      });
    } catch {
      // ignore
    }
  }
  const downstream = dag.getDownstreamImpact(outputKey);

  return {
    data: {
      ast,
      humanPreview: toHumanPreview(ast),
      formulaText: formulaText || astToCanonical(ast),
      formattedExpression: formatFormulaExpression(ast),
      naturalSource: naturalSource ?? null,
      recognizedVariables: recognized ?? [],
      ambiguities: ambiguities ?? [],
      suggestedCustomVariable: suggestedVar ?? null,
      outputVariableKey: outputKey,
      isNegative,
      negativeWarning: isNegative
        ? `${outputKey} evaluates to a negative value (${formatMinor(value)}). Please review your numbers.`
        : null,
      example: {
        period: { year: bounds.year, month: bounds.month, key: bounds.periodKey },
        variables: registry.variables.map((v) => ({
          name: v.key,
          label: v.displayName,
          unit: v.unit,
          value: v.valueRaw,
          valueFormatted: v.valueFormatted,
        })),
        steps,
        resultMinor: divideByZero ? null : value,
        resultFormatted: divideByZero ? "—" : formatMinor(value),
        resultPerMealMinor: perMeal,
        resultPerMealFormatted: perMeal !== null ? formatMinor(perMeal) : null,
        divideByZero,
        divideByZeroMessage,
      },
      explanation,
      downstreamFormulas: downstream,
    },
  };
});
