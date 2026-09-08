/**
 * GET /api/v1/admin/formulas/kpis
 *
 * Human-facing KPI control map. It exposes live values, provenance and the
 * safe edit path without introducing a second calculation engine.
 *
 * - SYSTEM: authoritative fact, visible but not redefinable.
 * - VARIABLE: editable setting/custom value; edit through Variable Engine.
 * - FORMULA: derived output; a new immutable FormulaVersion is the edit path.
 */
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import { gatherAllVariables } from "@/lib/domain/formula/registry";
import { selectFormulaVersionAt } from "@/lib/domain/formula/effective-version";
import { BUILTIN_KPI_CATALOG, type KpiCatalogSpec } from "@/lib/domain/formula/kpi-catalog";

export const dynamic = "force-dynamic";

type ControlKind = "SYSTEM" | "VARIABLE" | "FORMULA";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const periodParam = url.searchParams.get("period");

  if (periodParam && !/^\d{4}-\d{2}$/.test(periodParam)) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 422);
  }

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const current = currentPeriodBounds(tz);
  const bounds = periodParam
    ? (() => {
        const [year, month] = periodParam.split("-").map(Number);
        if (!year || !month || month < 1 || month > 12) {
          throw new ApiError(CODES.VALIDATION_FAILED, "Period must be a real YYYY-MM month.", 422);
        }
        return periodBounds(year, month, tz);
      })()
    : current;

  const [registry, definitions] = await Promise.all([
    gatherAllVariables(ctx.institutionId, bounds.year, bounds.month),
    db.formulaDefinition.findMany({
      where: { institutionId: ctx.institutionId },
      include: { versions: { orderBy: { version: "desc" } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const variableByKey = new Map(registry.variables.map((variable) => [variable.key, variable]));
  const formulaByOutput = new Map<string, { definition: any; version: any }>();

  for (const definition of definitions) {
    const version = selectFormulaVersionAt(definition.versions, bounds.startAt);
    if (version) formulaByOutput.set(definition.outputVariableKey, { definition, version });
  }

  const isCurrentPeriod = bounds.periodKey === current.periodKey;

  const buildItem = (spec: KpiCatalogSpec, custom = false) => {
    const variable = variableByKey.get(spec.sourceKey);
    const formula = formulaByOutput.get(spec.sourceKey);
    const control: ControlKind = formula ? "FORMULA" : variable?.isEditable ? "VARIABLE" : "SYSTEM";
    const canEdit = isCurrentPeriod && control !== "SYSTEM";

    return {
      key: spec.key,
      label: spec.label,
      page: spec.page,
      description: spec.description,
      sourceKey: spec.sourceKey,
      sourceLabel: formula?.definition.name ?? variable?.displayName ?? spec.sourceKey,
      valueRaw: registry.valuesMap[spec.sourceKey] ?? variable?.valueRaw ?? 0,
      valueFormatted: variable?.valueFormatted ?? "—",
      valueType: variable?.valueType ?? "NUMBER",
      unit: variable?.unit ?? "NONE",
      control,
      canEdit,
      custom,
      systemLockedReason:
        control === "SYSTEM"
          ? "This is an authoritative BoardOps fact. Use it in formulas, but do not redefine it."
          : null,
      formula: formula
        ? {
            definitionId: formula.definition.id,
            name: formula.definition.name,
            outputVariableKey: formula.definition.outputVariableKey,
            version: formula.version.version,
            expressionSource: formula.version.expressionSource,
            humanPreview: formula.version.humanPreview,
            reason: formula.version.reason ?? null,
          }
        : null,
      variable: variable
        ? {
            key: variable.key,
            category: variable.category,
            editable: Boolean(variable.isEditable),
            description: variable.description,
            usedByFormulas: variable.usedByFormulas,
          }
        : null,
    };
  };

  const items = BUILTIN_KPI_CATALOG.map((spec) => buildItem(spec));
  const builtInSources = new Set(BUILTIN_KPI_CATALOG.map((item) => item.sourceKey));

  // Every additional FormulaDefinition automatically becomes a visible custom
  // calculation KPI. Admins therefore do not need a second "KPI builder" model.
  for (const [outputVariableKey, entry] of formulaByOutput.entries()) {
    if (builtInSources.has(outputVariableKey)) continue;
    items.push(
      buildItem(
        {
          key: `custom_${outputVariableKey}`,
          label: entry.definition.name,
          page: "Custom",
          sourceKey: outputVariableKey,
          description: entry.definition.description ?? "Custom calculation created in Formula Engine.",
        },
        true
      )
    );
  }

  return {
    data: {
      period: registry.period,
      isCurrentPeriod,
      items,
      meta: {
        total: items.length,
        editable: items.filter((item) => item.canEdit).length,
        formulas: items.filter((item) => item.control === "FORMULA").length,
        systemFacts: items.filter((item) => item.control === "SYSTEM").length,
        custom: items.filter((item) => item.custom).length,
      },
      guidance: {
        instantApply: "Saving a formula creates a new audited version and refreshes live/open calculations immediately.",
        historySafety: "Generated bills keep their frozen snapshot and never change when a later formula version is activated.",
        systemSafety: "Ledger balances, counts and other authoritative system facts are visible inputs but cannot be redefined.",
      },
    },
  };
});
