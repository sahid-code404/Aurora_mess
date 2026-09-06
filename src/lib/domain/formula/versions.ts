/**
 * FORMULA DEFINITIONS & VERSIONING (spec §59-63, §113-114, §122)
 *
 * Generic multi-formula version management:
 *  - FormulaDefinition owns one output variable (e.g. "meal_charge", "total_kitchen_cost")
 *  - FormulaVersion is immutable after creation
 *  - FormulaDependency records enable DAG cycle detection and fast cache invalidation
 *  - Closed historical billing periods are never modified
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { getInstitution } from "@/lib/institution";
import { formatMinor } from "@/lib/money";
import { appendAudit } from "@/lib/audit";
import { localDateMidnightUtc } from "@/lib/time";
import { extractVariableNames, FormulaAst } from "./ast";
import { evaluateFormula, toHumanPreview } from "./evaluator";
import { astToCanonical, formatFormulaExpression, parseFormula } from "./parser";
import { parseNaturalLanguage } from "./nl";
import { currentPeriodBounds, periodBounds } from "./period-variables";
import { SYSTEM_VARIABLES_MAP } from "./variables";
import { FormulaDag } from "./dag";
import { gatherAllVariables } from "./registry";
import { selectFormulaVersionAt } from "./effective-version";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import { assertFormulaInputPeriodMutable } from "./period-mutation";

export interface FormulaVersionRow {
  id: string;
  formulaDefinitionId: string;
  version: number;
  inputMode: string;
  expressionSource: string;
  naturalSource: string | null;
  normalizedExpression: string | null;
  humanPreview: string;
  outputType: string;
  checksum: string;
  reason: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: string;
  active: boolean;
  createdAt: string;
}

export function serializeFormulaVersion(v: any): FormulaVersionRow {
  return {
    id: v.id,
    formulaDefinitionId: v.formulaDefinitionId,
    version: v.version,
    inputMode: v.inputMode,
    expressionSource: v.expressionSource,
    naturalSource: v.naturalSource ?? null,
    normalizedExpression: v.normalizedExpression ?? null,
    humanPreview: v.humanPreview,
    outputType: v.outputType ?? "MONEY_PER_MEAL",
    checksum: v.checksum,
    reason: v.reason ?? null,
    effectiveFrom: v.effectiveFrom ? new Date(v.effectiveFrom).toISOString() : null,
    effectiveUntil: v.effectiveUntil ? new Date(v.effectiveUntil).toISOString() : null,
    status: v.status ?? (v.active ? "ACTIVE" : "HISTORICAL"),
    active: Boolean(v.active),
    createdAt: new Date(v.createdAt).toISOString(),
  };
}

/** Idempotently ensure the institution's primary meal charge formula definition exists. */
export async function ensureFormulaDefinition(
  institutionId: string,
  outputVariableKey = "meal_charge",
  client: any = db
): Promise<any> {
  let definition = await client.formulaDefinition.findFirst({
    where: { institutionId, outputVariableKey },
  });

  if (!definition) {
    definition = await client.formulaDefinition.create({
      data: {
        institutionId,
        name: outputVariableKey === "meal_charge" ? "Meal Charge" : outputVariableKey,
        description: outputVariableKey === "meal_charge" ? "Calculates resident meal charge for billing period." : null,
        outputVariableKey,
        scope: "BILLING_PERIOD",
      },
    });
  }
  return definition;
}

/** Resolve the formula version whose effective window covers the period start. */
export async function resolveFormulaVersionForPeriod(
  institutionId: string,
  periodStart: Date,
  outputVariableKey = "meal_charge",
  client: any = db
): Promise<any | null> {
  const definition = await ensureFormulaDefinition(institutionId, outputVariableKey, client);
  const versions = await client.formulaVersion.findMany({
    where: { formulaDefinitionId: definition.id },
    orderBy: { version: "desc" },
  });

  return selectFormulaVersionAt(versions, periodStart);
}

export interface FormulaEstimate {
  period: { year: number; month: number };
  resultMinor: number | null;
  resultFormatted: string;
  perMealMinor: number | null;
  perMealFormatted: string | null;
  divideByZero: boolean;
  unavailable: boolean;
  isNegative: boolean;
  note: string | null;
  variables: { name: string; label: string; unit: string; value: number; valueFormatted: string }[];
}

/** Evaluate an AST against real period data. */
export async function formulaEstimate(
  institutionId: string,
  ast: FormulaAst,
  year?: number,
  month?: number
): Promise<FormulaEstimate> {
  const inst = await getInstitution(institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = year && month ? periodBounds(year, month, tz) : currentPeriodBounds(tz);

  const registry = await gatherAllVariables(institutionId, bounds.year, bounds.month);
  const variables = registry.valuesMap;

  let resultMinor: number | null = null;
  let divideByZero = false;
  let note: string | null = null;

  try {
    resultMinor = evaluateFormula(ast, variables);
  } catch (error) {
    if (error instanceof ApiError && error.code === CODES.FORMULA_DIVIDE_BY_ZERO) {
      divideByZero = true;
      note = error.message;
    } else {
      throw error;
    }
  }

  const meals = variables.total_resident_meals ?? variables.total_consumed_resident_meals ?? 0;
  const perMeal = meals > 0 && resultMinor !== null ? Math.round(resultMinor / meals) : null;
  const isNegative = resultMinor !== null && resultMinor < 0;

  if (isNegative) {
    note = "The formula produces a negative result. Review the calculation before billing.";
  }

  return {
    period: { year: bounds.year, month: bounds.month },
    resultMinor,
    resultFormatted: resultMinor !== null ? formatMinor(resultMinor) : "—",
    perMealMinor: perMeal,
    perMealFormatted: perMeal !== null ? formatMinor(perMeal) : null,
    divideByZero,
    unavailable: resultMinor === null,
    isNegative,
    note,
    variables: registry.variables.map((v) => ({
      name: v.key,
      label: v.displayName,
      unit: v.unit,
      value: v.valueRaw,
      valueFormatted: v.valueFormatted,
    })),
  };
}

export interface CreateVersionInput {
  institutionId: string;
  adminUserId: string;
  requestId: string;
  outputVariableKey?: string;
  name?: string;
  mode: "FORMULA" | "NATURAL_LANGUAGE";
  source: string;
  reason?: string;
  effective: "NEXT_PERIOD" | "CURRENT_OPEN";
  confirmImpact?: boolean;
}

export type CreateVersionOutcome =
  | {
      created: true;
      version: FormulaVersionRow;
      estimate: FormulaEstimate;
      effectiveFrom: string | null;
      effectiveLabel: string;
    }
  | {
      created: false;
      requireConfirmation: true;
      currentVersion: FormulaVersionRow | null;
      newEstimate: FormulaEstimate;
      currentEstimate: FormulaEstimate | null;
      differenceMinor: number;
      differenceFormatted: string;
      affectedFormulas: string[];
    };

/** Parse source (formula text or plain English) into AST. */
export async function parseFormulaSource(
  mode: "FORMULA" | "NATURAL_LANGUAGE",
  source: string
): Promise<{ ast: FormulaAst; formulaText: string; naturalSource: string | null; recognized?: any[]; ambiguities?: any[]; suggestedVar?: any }> {
  if (mode === "NATURAL_LANGUAGE") {
    const parsed = await parseNaturalLanguage(source);
    return {
      ast: parsed.ast,
      formulaText: parsed.formulaText,
      naturalSource: parsed.naturalSource,
      recognized: parsed.recognizedVariables,
      ambiguities: parsed.ambiguities,
      suggestedVar: parsed.suggestedCustomVariable,
    };
  }
  const ast = parseFormula(source);
  return { ast, formulaText: astToCanonical(ast), naturalSource: null };
}

async function buildFormulaDagForPeriod(
  client: any,
  institutionId: string,
  outputKey: string,
  targetPeriodStart: Date
): Promise<FormulaDag> {
  const allFormulaDefs = await client.formulaDefinition.findMany({
    where: { institutionId },
    include: {
      versions: {
        orderBy: { version: "desc" },
        include: { dependencies: true },
      },
    },
  });

  const dag = new FormulaDag();
  for (const def of allFormulaDefs) {
    if (def.outputVariableKey === outputKey) continue;
    const periodVersion: any = selectFormulaVersionAt(def.versions, targetPeriodStart);
    if (!periodVersion) continue;
    try {
      const nodeAst = JSON.parse(periodVersion.compiledAstJson) as FormulaAst;
      dag.addNode({
        outputVariableKey: def.outputVariableKey,
        formulaDefinitionId: def.id,
        name: def.name,
        ast: nodeAst,
        dependsOn: periodVersion.dependencies.map((d: any) => d.variableKey),
      });
    } catch {
      // Ignore malformed legacy rows here; normal activation/build validation
      // remains fail-closed for newly persisted formula data.
    }
  }
  return dag;
}

/** Create a new immutable formula version with DAG cycle detection. */
export async function createFormulaVersion(input: CreateVersionInput): Promise<CreateVersionOutcome> {
  const inst = await getInstitution(input.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = currentPeriodBounds(tz);

  const { ast, formulaText, naturalSource } = await parseFormulaSource(input.mode, input.source);
  const outputKey = (ast.type === "assignment" ? ast.target : input.outputVariableKey ?? "meal_charge").trim();

  // 1. DAG cycle check (spec §44). Resolve every dependency formula for
  // the same effective period as the candidate; the latest active pointer can
  // point at NEXT_PERIOD and must never rewrite current/historical evaluation.
  const nextYear = bounds.month === 12 ? bounds.year + 1 : bounds.year;
  const nextMonth = bounds.month === 12 ? 1 : bounds.month + 1;
  const nextMonthFirst = localDateMidnightUtc(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`);
  const targetPeriodStart = input.effective === "CURRENT_OPEN" ? bounds.startAt : nextMonthFirst;

  const dag = await buildFormulaDagForPeriod(
    db,
    input.institutionId,
    outputKey,
    targetPeriodStart
  );

  // Validate no circular dependency
  dag.validateNoCycles(outputKey, ast);
  const downstream = dag.getDownstreamImpact(outputKey);

  // 2. Evaluate new candidate against context
  const newEstimate = await formulaEstimate(input.institutionId, ast, bounds.year, bounds.month);

  // 3. Impact comparison if saving to CURRENT_OPEN without explicit confirm
  if (input.effective === "CURRENT_OPEN" && input.confirmImpact !== true) {
    const current = await resolveFormulaVersionForPeriod(input.institutionId, bounds.startAt, outputKey);
    const currentEstimate = current
      ? await formulaEstimate(input.institutionId, JSON.parse(current.compiledAstJson) as FormulaAst, bounds.year, bounds.month)
      : null;

    const diff = (newEstimate.resultMinor ?? 0) - (currentEstimate?.resultMinor ?? 0);

    return {
      created: false,
      requireConfirmation: true,
      currentVersion: current ? serializeFormulaVersion(current) : null,
      newEstimate,
      currentEstimate,
      differenceMinor: diff,
      differenceFormatted: `${diff >= 0 ? "+" : ""}${formatMinor(diff)}`,
      affectedFormulas: downstream,
    };
  }

  // 4. Compute effective window
  const thisMonthEnd = new Date(nextMonthFirst.getTime() - 1);
  const effectiveFrom = targetPeriodStart;
  const previousUntil = input.effective === "CURRENT_OPEN" ? new Date(bounds.startAt.getTime() - 1) : thisMonthEnd;

  const compiledAstJson = JSON.stringify(ast);
  const checksum = createHash("sha256").update(compiledAstJson).digest("hex");
  const referencedVars = extractVariableNames(ast);

  const version = await db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, input.institutionId);
    const targetYear = input.effective === "CURRENT_OPEN" ? bounds.year : nextYear;
    const targetMonth = input.effective === "CURRENT_OPEN" ? bounds.month : nextMonth;
    await assertFormulaInputPeriodMutable(tx, input.institutionId, targetYear, targetMonth);

    // Preview/cycle checks happen before confirmation for UX, but mutation must
    // re-check under the shared Institution mutex so two concurrent formula
    // writes cannot each validate against stale dependency graphs.
    const lockedDag = await buildFormulaDagForPeriod(
      tx,
      input.institutionId,
      outputKey,
      targetPeriodStart
    );
    lockedDag.validateNoCycles(outputKey, ast);

    const definition = await ensureFormulaDefinition(input.institutionId, outputKey, tx);

    const maxAgg = await tx.formulaVersion.aggregate({
      where: { formulaDefinitionId: definition.id },
      _max: { version: true },
    });
    const nextVersionNumber = (maxAgg._max.version ?? 0) + 1;

    const created = await tx.formulaVersion.create({
      data: {
        formulaDefinitionId: definition.id,
        version: nextVersionNumber,
        inputMode: input.mode,
        expressionSource: astToCanonical(ast),
        naturalSource,
        normalizedExpression: formatFormulaExpression(ast),
        compiledAstJson,
        humanPreview: toHumanPreview(ast),
        outputType: outputKey.includes("charge") ? "MONEY_PER_MEAL" : "MONEY",
        checksum,
        reason: input.reason ?? null,
        effectiveFrom,
        effectiveUntil: null,
        status: "ACTIVE",
        active: true,
        createdByUserId: input.adminUserId,
      },
    });

    // Save dependencies
    for (const varKey of referencedVars) {
      await tx.formulaDependency.create({
        data: {
          formulaVersionId: created.id,
          variableKey: varKey,
          dependencyType: SYSTEM_VARIABLES_MAP[varKey] ? "SYSTEM" : "DERIVED",
        },
      });
    }

    // Retire old active version
    await tx.formulaVersion.updateMany({
      where: {
        formulaDefinitionId: definition.id,
        id: { not: created.id },
        active: true,
      },
      data: {
        active: false,
        status: "HISTORICAL",
        effectiveUntil: previousUntil,
      },
    });

    await tx.formulaDefinition.update({
      where: { id: definition.id },
      data: { activeVersionId: created.id, name: input.name ?? definition.name },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "FORMULA_VERSION_CREATED",
        entityType: "FORMULA_VERSION",
        entityId: created.id,
        requestId: input.requestId,
        reason: input.reason ?? null,
        beforeSummary: "Previous active retired",
        afterSummary: `v${created.version} effective ${input.effective}`,
        metadata: {
          formula: outputKey,
          version: created.version,
          expressionSource: created.expressionSource,
          checksum,
        },
      },
      tx
    );

    return created;
  });

  const effectiveLabel =
    input.effective === "CURRENT_OPEN"
      ? "applies to current open period immediately"
      : `applies from ${nextYear}-${String(nextMonth).padStart(2, "0")}`;

  return {
    created: true,
    version: serializeFormulaVersion(version),
    estimate: newEstimate,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveLabel,
  };
}
