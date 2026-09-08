/**
 * /api/v1/admin/formulas/kpis
 *
 * Simple Admin-facing KPI registry. A KPI can keep its trusted native page value
 * or display an existing BoardOps Variable/Formula output. This is presentation
 * configuration only: it never mutates ledger facts, bills, snapshots or source
 * domain records.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { getInstitution } from "@/lib/institution";
import { ApiError, CODES } from "@/lib/errors";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import { gatherAllVariables, type ResolvedVariableItem } from "@/lib/domain/formula/registry";
import {
  KPI_CATALOG,
  KPI_SURFACE_LABELS,
  kpiCatalogEntry,
  readKpiConfiguration,
  updateKpiConfiguration,
  type KpiSourceMode,
} from "@/lib/domain/kpi-registry";

export const dynamic = "force-dynamic";

function compactValue(variable: ResolvedVariableItem): string {
  if (variable.valueType === "BOOLEAN") return variable.valueRaw ? "Yes" : "No";
  if (variable.valueType === "PERCENTAGE" || variable.unit === "PERCENT") return `${variable.valueRaw}%`;
  if (variable.valueType === "MONEY" || variable.unit === "INR") return variable.valueFormatted;
  return Number(variable.valueRaw).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function resolveBounds(periodParam: string | null, tz: string) {
  if (!periodParam) return currentPeriodBounds(tz);
  const match = /^(\d{4})-(\d{2})$/.exec(periodParam);
  if (!match) throw new ApiError(CODES.VALIDATION_FAILED, "Period must use YYYY-MM format.", 422);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new ApiError(CODES.VALIDATION_FAILED, "Period month must be between 01 and 12.", 422);
  return periodBounds(year, month, tz);
}

function sourceKind(variable: ResolvedVariableItem | undefined): "FORMULA" | "VARIABLE" | null {
  if (!variable) return null;
  return variable.category === "DERIVED" ? "FORMULA" : "VARIABLE";
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const surface = url.searchParams.get("surface")?.trim() || null;
  const includeSources = url.searchParams.get("includeSources") === "1";
  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = resolveBounds(url.searchParams.get("period"), tz);

  const [configuration, registry] = await Promise.all([
    readKpiConfiguration(ctx.institutionId),
    gatherAllVariables(ctx.institutionId, bounds.year, bounds.month),
  ]);
  const variableMap = new Map(registry.variables.map((item) => [item.key, item]));

  const entries = KPI_CATALOG.filter((entry) => !surface || entry.surface === surface).map((entry) => {
    const config = configuration.snapshot.items[entry.key];
    const variable = config?.sourceVariableKey ? variableMap.get(config.sourceVariableKey) : undefined;
    const sourceAvailable = config?.sourceMode !== "VARIABLE" || Boolean(variable);
    return {
      key: entry.key,
      surface: entry.surface,
      surfaceLabel: KPI_SURFACE_LABELS[entry.surface] ?? entry.surface,
      nativeLabel: entry.nativeLabel,
      label: config?.label ?? entry.nativeLabel,
      description: entry.description,
      enabled: config?.enabled !== false,
      sourceMode: (config?.sourceMode ?? entry.defaultSourceMode) as KpiSourceMode,
      sourceVariableKey: config?.sourceVariableKey ?? entry.defaultSourceVariableKey,
      sourceDisplayName: variable?.displayName ?? null,
      sourceCategory: variable?.category ?? null,
      sourceKind: sourceKind(variable),
      sourceAvailable,
      valueRaw: variable?.valueRaw ?? null,
      valueFormatted: variable ? compactValue(variable) : null,
      isConfigured:
        config?.label !== entry.nativeLabel ||
        config?.enabled === false ||
        config?.sourceMode !== entry.defaultSourceMode ||
        config?.sourceVariableKey !== entry.defaultSourceVariableKey,
    };
  });

  const sources = includeSources
    ? registry.variables
        .filter((item) => item.scope !== "RESIDENT")
        .map((item) => ({
          key: item.key,
          displayName: item.displayName,
          description: item.description,
          category: item.category,
          sourceKind: item.category === "DERIVED" ? "FORMULA" : "VARIABLE",
          valueType: item.valueType,
          unit: item.unit,
          valueRaw: item.valueRaw,
          valueFormatted: compactValue(item),
          usedByFormulas: item.usedByFormulas,
        }))
        .sort((a, b) => {
          const rank = (category: string) => (category === "DERIVED" ? 0 : category === "CUSTOM" ? 1 : 2);
          return rank(a.category) - rank(b.category) || a.displayName.localeCompare(b.displayName);
        })
    : undefined;

  return {
    data: {
      period: { year: bounds.year, month: bounds.month, key: bounds.periodKey },
      configurationVersion: configuration.version,
      configurationUpdatedAt: configuration.updatedAt?.toISOString() ?? null,
      kpis: entries,
      sources,
      surfaces: Object.entries(KPI_SURFACE_LABELS).map(([key, label]) => ({ key, label })),
    },
  };
});

const bodySchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().trim().min(1, "KPI name is required.").max(50),
  enabled: z.boolean(),
  sourceMode: z.enum(["NATIVE", "VARIABLE"]),
  sourceVariableKey: z.string().trim().min(1).max(100).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const catalog = kpiCatalogEntry(body.key);
  if (!catalog) throw new ApiError(CODES.NOT_FOUND, "KPI definition not found.", 404);

  let sourceVariableKey: string | null = null;
  if (body.sourceMode === "VARIABLE") {
    sourceVariableKey = body.sourceVariableKey ?? null;
    if (!sourceVariableKey) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Choose a Variable or Formula for this KPI.", 422, {
        sourceVariableKey: "Choose a Variable or Formula.",
      });
    }

    const inst = await getInstitution(ctx.institutionId);
    const bounds = currentPeriodBounds(inst?.timezone ?? "UTC");
    const registry = await gatherAllVariables(ctx.institutionId, bounds.year, bounds.month);
    const source = registry.variables.find((item) => item.key === sourceVariableKey);
    if (!source) {
      throw new ApiError(CODES.VALIDATION_FAILED, "The selected Variable or Formula is not available.", 422, {
        sourceVariableKey: "This source is unavailable.",
      });
    }
    if (source.scope === "RESIDENT") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Resident-specific values cannot power an institution-level Admin KPI.",
        422,
        { sourceVariableKey: "Choose an institution or billing-period value." }
      );
    }
  }

  const outcome = await updateKpiConfiguration({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    requestId: ctx.requestId,
    key: body.key,
    item: {
      label: body.label.trim(),
      enabled: body.enabled,
      sourceMode: body.sourceMode,
      sourceVariableKey,
    },
    reason: body.reason,
  });

  return {
    data: {
      key: body.key,
      surface: catalog.surface,
      label: body.label.trim(),
      enabled: body.enabled,
      sourceMode: body.sourceMode,
      sourceVariableKey,
      configurationVersion: outcome.version,
      updatedAt: outcome.updatedAt.toISOString(),
      message: "KPI saved and applied. Current live views use the new setting immediately; historical billing remains unchanged.",
    },
  };
});
