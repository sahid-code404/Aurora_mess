/**
 * CENTRAL VARIABLE REGISTRY & PROVIDER ORCHESTRATOR (spec §4, §6, §144)
 *
 * Coordinates modular domain providers:
 *  - ResidentVariableProvider
 *  - MealVariableProvider
 *  - GuestMealVariableProvider
 *  - KitchenServingProvider
 *  - ExpenseVariableProvider
 *  - PaymentVariableProvider
 *  - FundsVariableProvider
 *  - ContextVariableProvider
 *  - CustomVariableProvider
 *  - DerivedVariableProvider (evaluates DAG formulas in topological order)
 */
import { db } from "@/lib/db";
import { formatMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { PeriodBounds, periodBounds, currentPeriodBounds } from "./period-variables";
import {
  SYSTEM_VARIABLES,
  VariableCategory,
  VariableDefinitionSpec,
  VariableUnit,
  VariableValueType,
} from "./variables";
import { resolveResidentVariables } from "./providers/resident";
import { resolveMealVariables } from "./providers/meal";
import { resolveGuestVariables } from "./providers/guest";
import { resolveKitchenVariables } from "./providers/kitchen";
import { resolveExpenseVariables } from "./providers/expense";
import { resolvePaymentVariables } from "./providers/payment";
import { resolveFundsVariables } from "./providers/funds";
import { resolveContextVariables } from "./providers/context";
import { resolveCustomVariables } from "./providers/custom";
import { FormulaDag } from "./dag";
import { evaluateFormula } from "./evaluator";
import { FormulaAst } from "./ast";
import { selectFormulaVersionAt } from "./effective-version";

export interface ResolvedVariableItem {
  id?: string;
  key: string;
  displayName: string;
  description: string;
  category: VariableCategory;
  valueType: VariableValueType;
  unit: VariableUnit;
  scope: string;
  frequency?: string;
  valueRaw: number;
  valueFormatted: string;
  isPinned: boolean;
  isEditable?: boolean;
  providerKey?: string;
  usedByFormulas: string[];
  effectivePeriod?: string;
}

export interface VariableRegistryResult {
  period: { year: number; month: number; key: string };
  variables: ResolvedVariableItem[];
  valuesMap: Record<string, number>;
}

export async function gatherAllVariables(
  institutionId: string,
  year: number,
  month: number,
  residentId?: string,
  client: any = db
): Promise<VariableRegistryResult> {
  const inst = await getInstitution(institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = periodBounds(year, month, tz);

  // 1. Resolve base domain providers in parallel
  const [
    residentVars,
    mealVars,
    guestVars,
    expenseVars,
    paymentVars,
    fundsVars,
    customVars,
    customDefs,
    formulaDefs,
  ] = await Promise.all([
    resolveResidentVariables(institutionId, bounds, client),
    resolveMealVariables(institutionId, bounds, residentId, client),
    resolveGuestVariables(institutionId, bounds, residentId, client),
    resolveExpenseVariables(institutionId, bounds, client),
    resolvePaymentVariables(institutionId, bounds, client),
    resolveFundsVariables(institutionId, client),
    resolveCustomVariables(institutionId, bounds, residentId, client),
    client.variableDefinition.findMany({
      where: {
        institutionId,
        OR: [{ archivedAt: null }, { archivedAt: { gt: bounds.startAt } }],
      },
    }),
    client.formulaDefinition.findMany({
      where: { institutionId },
      include: {
        versions: {
          orderBy: { version: "desc" },
          include: { dependencies: true },
        },
      },
    }),
  ]);

  const formulaDefsForPeriod = formulaDefs.flatMap((def: any) => {
    const periodVersion = selectFormulaVersionAt(def.versions, bounds.startAt);
    return periodVersion ? [{ ...def, versions: [periodVersion] }] : [];
  });

  const kitchenVars = resolveKitchenVariables(
    mealVars.total_resident_meals,
    guestVars.total_guest_meals
  );
  const contextVars = resolveContextVariables(bounds);

  // Merge all base (system + custom) values into a working map
  const valuesMap: Record<string, number> = {
    ...residentVars,
    ...mealVars,
    ...guestVars,
    ...kitchenVars,
    ...expenseVars,
    ...paymentVars,
    ...fundsVars,
    ...contextVars,
    ...customVars,
  };

  // 2. Build DAG and evaluate Derived Variables in topological order (spec §43, §87)
  const dag = new FormulaDag();
  const formulaByOutput = new Map<string, { def: any; version: any }>();

  for (const def of formulaDefsForPeriod) {
    const activeVersion = def.versions[0];
    if (activeVersion) {
      try {
        const ast = JSON.parse(activeVersion.compiledAstJson) as FormulaAst;
        const deps = activeVersion.dependencies.map((d: any) => d.variableKey);
        dag.addNode({
          outputVariableKey: def.outputVariableKey,
          formulaDefinitionId: def.id,
          name: def.name,
          ast,
          dependsOn: deps,
        });
        formulaByOutput.set(def.outputVariableKey, { def, version: activeVersion });
      } catch {
        // Skip malformed ASTs
      }
    }
  }

  // Topologically evaluate active derived formulas
  try {
    const evalOrder = dag.getTopologicalOrder();
    for (const outputKey of evalOrder) {
      const entry = formulaByOutput.get(outputKey);
      if (entry) {
        try {
          const ast = JSON.parse(entry.version.compiledAstJson) as FormulaAst;
          const val = evaluateFormula(ast, valuesMap);
          valuesMap[outputKey] = val;
        } catch {
          // If division by zero or missing variable, leave undefined or 0
        }
      }
    }
  } catch {
    // If circular dependency in legacy data, evaluate best-effort
    for (const [outputKey, entry] of formulaByOutput.entries()) {
      if (valuesMap[outputKey] === undefined) {
        try {
          const ast = JSON.parse(entry.version.compiledAstJson) as FormulaAst;
          valuesMap[outputKey] = evaluateFormula(ast, valuesMap);
        } catch {
          // ignore
        }
      }
    }
  }

  // 3. Compile full metadata items list
  const customMap = new Map<string, any>(customDefs.map((c: any) => [c.key, c]));
  const items: ResolvedVariableItem[] = [];

  // System variables — filter out RESIDENT-scoped vars (they duplicate their global
  // counterparts when no specific resident is selected) and calendar metadata noise.
  const hiddenFromAdminList = new Set([
    "resident_meal_count",      // Same as total_resident_meals in global context
    "resident_guest_meals",     // Same as total_guest_meals in global context
    "guest_income_for_resident",// Same as total_guest_income in global context
    "selected_year",            // Calendar metadata, rarely useful in formulas
    "selected_month",           // Calendar metadata, rarely useful in formulas
  ]);

  for (const sys of SYSTEM_VARIABLES) {
    if (hiddenFromAdminList.has(sys.key)) continue;

    const raw = valuesMap[sys.key] ?? 0;
    const isCustomOverride = customMap.get(sys.key);
    const usedBy = formulaDefsForPeriod
      .filter((fd: any) =>
        fd.versions[0]?.dependencies.some((d: any) => d.variableKey === sys.key)
      )
      .map((fd: any) => fd.name);

    items.push({
      key: sys.key,
      displayName: sys.displayName,
      description: sys.description,
      category: "SYSTEM",
      valueType: sys.valueType,
      unit: sys.unit,
      scope: sys.scope,
      valueRaw: raw,
      valueFormatted: formatVarValue(raw, sys.valueType, sys.unit),
      isPinned: isCustomOverride?.isPinned ?? false,
      isEditable: sys.isEditable ?? false,
      providerKey: sys.providerKey,
      usedByFormulas: usedBy,
    });
  }

  // Custom variables
  for (const c of customDefs) {
    if (c.category === "CUSTOM") {
      const raw = valuesMap[c.key] ?? 0;
      const usedBy = formulaDefsForPeriod
        .filter((fd: any) =>
          fd.versions[0]?.dependencies.some((d: any) => d.variableKey === c.key)
        )
        .map((fd: any) => fd.name);

      items.push({
        id: c.id,
        key: c.key,
        displayName: c.displayName,
        description: c.description,
        category: "CUSTOM",
        valueType: c.valueType as VariableValueType,
        unit: c.unit as VariableUnit,
        scope: c.scope,
        frequency: c.frequency ?? "MONTHLY",
        valueRaw: raw,
        valueFormatted: formatVarValue(raw, c.valueType as VariableValueType, c.unit as VariableUnit),
        isPinned: c.isPinned,
        isEditable: true,
        usedByFormulas: usedBy,
      });
    }
  }

  // Derived variables (from FormulaDefinitions)
  for (const f of formulaDefsForPeriod) {
    const raw = valuesMap[f.outputVariableKey] ?? 0;
    const activeVersion = f.versions[0];
    const isCharge = f.outputVariableKey.includes("charge");
    const formatted = isCharge
      ? `${formatMinor(raw)} / meal`
      : formatMinor(raw);

    const usedBy = formulaDefsForPeriod
      .filter(
        (fd: any) =>
          fd.id !== f.id &&
          fd.versions[0]?.dependencies.some(
            (d: any) => d.variableKey === f.outputVariableKey
          )
      )
      .map((fd: any) => fd.name);

    items.push({
      id: f.id,
      key: f.outputVariableKey,
      displayName: f.name,
      description: f.description ?? `Calculated via formula ${activeVersion ? `v${activeVersion.version}` : ""}`,
      category: "DERIVED",
      valueType: "MONEY",
      unit: isCharge ? "INR" : "INR",
      scope: f.scope,
      valueRaw: raw,
      valueFormatted: formatted,
      isPinned: false,
      isEditable: false,
      usedByFormulas: usedBy,
    });
  }

  return {
    period: { year: bounds.year, month: bounds.month, key: bounds.periodKey },
    variables: items,
    valuesMap,
  };
}

function formatVarValue(val: number, type: VariableValueType, unit: VariableUnit): string {
  if (type === "MONEY" || unit === "INR") {
    return formatMinor(val);
  }
  if (type === "PERCENTAGE" || unit === "PERCENT") {
    return `${val}%`;
  }
  if (unit === "MEALS") {
    return `${val.toLocaleString()} meals`;
  }
  if (unit === "RESIDENTS") {
    return `${val.toLocaleString()} residents`;
  }
  if (unit === "DAYS") {
    return `${val} days`;
  }
  if (unit === "HOURS") {
    return `${val} hrs`;
  }
  return val.toLocaleString();
}
