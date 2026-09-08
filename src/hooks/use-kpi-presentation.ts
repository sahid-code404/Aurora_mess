"use client";

import { useEffect, useMemo, useState } from "react";
import { useApiQuery } from "@/hooks/use-api-query";

export type KpiPresentationRow = {
  key: string;
  surface: string;
  nativeLabel: string;
  label: string;
  enabled: boolean;
  sourceMode: "NATIVE" | "VARIABLE";
  sourceVariableKey: string | null;
  sourceDisplayName: string | null;
  sourceCategory: "SYSTEM" | "CUSTOM" | "DERIVED" | null;
  sourceKind: "FORMULA" | "VARIABLE" | null;
  sourceAvailable: boolean;
  valueRaw: number | null;
  valueFormatted: string | null;
};

type KpiSurfaceData = {
  kpis: KpiPresentationRow[];
};

type LiveVariable = {
  key: string;
  valueRaw: number;
  valueFormatted: string;
  valueType: string;
  unit: string;
};

type LiveVariableData = {
  variables: LiveVariable[];
};

const SUPPORTED_SURFACES = new Set([
  "dashboard",
  "formulas",
  "expenses",
  "payments",
  "funds",
  "billing",
  "residents",
  "tasks",
  "audit",
]);

function surfaceFromHash(hash: string): string | null {
  const match = /^#\/admin(?:\/([^/?]+))?/.exec(hash);
  if (!match) return null;
  const surface = match[1] || "dashboard";
  return SUPPORTED_SURFACES.has(surface) ? surface : null;
}

function compactVariableValue(variable: LiveVariable | undefined): string | null {
  if (!variable) return null;
  if (variable.valueType === "BOOLEAN") return variable.valueRaw ? "Yes" : "No";
  if (variable.valueType === "PERCENTAGE" || variable.unit === "PERCENT") return `${variable.valueRaw}%`;
  if (variable.valueType === "MONEY" || variable.unit === "INR") return variable.valueFormatted;
  return Number(variable.valueRaw).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * True when the visible Admin surface is intentionally looking at a non-current
 * day/month. In that case page-native/snapshot values remain authoritative;
 * live Formula/Variable overrides are never painted over historical data.
 */
function readHistoricalPeriodMarker(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[data-boardops-period-view="historical"]'));
}

export function useKpiPresentation(nativeLabel: string, nativeValue: string | number | null | undefined) {
  const [surface, setSurface] = useState<string | null>(() =>
    typeof window === "undefined" ? null : surfaceFromHash(window.location.hash)
  );
  const [historicalView, setHistoricalView] = useState(false);

  useEffect(() => {
    const read = () => setSurface(surfaceFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  useEffect(() => {
    const read = () => setHistoricalView(readHistoricalPeriodMarker());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-boardops-period-view"],
    });
    return () => observer.disconnect();
  }, [surface]);

  const configQuery = useApiQuery<KpiSurfaceData>(surface ? "/api/v1/admin/formulas/kpis" : null, {
    surface: surface ?? undefined,
  }, {
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  // Formula/Variable edits already invalidate this canonical registry. Keeping
  // live KPI values sourced from it means Save & Apply is reflected immediately
  // without polling or a page reload.
  const variablesQuery = useApiQuery<LiveVariableData>(
    surface ? "/api/v1/admin/formulas/variables" : null,
    undefined,
    { staleTime: 5_000, refetchOnWindowFocus: true }
  );

  return useMemo(() => {
    const row = configQuery.data?.kpis.find((item) => item.nativeLabel === nativeLabel) ?? null;
    if (!row) {
      return {
        label: nativeLabel,
        value: nativeValue,
        enabled: true,
        managed: false,
        sourceMode: "NATIVE" as const,
      };
    }

    const liveVariable = row.sourceVariableKey
      ? variablesQuery.data?.variables.find((item) => item.key === row.sourceVariableKey)
      : undefined;
    const liveValue = compactVariableValue(liveVariable) ?? row.valueFormatted;
    const canUseLiveSource =
      !historicalView &&
      row.sourceMode === "VARIABLE" &&
      row.sourceAvailable &&
      liveValue != null;

    return {
      label: row.label || nativeLabel,
      value: canUseLiveSource ? liveValue : nativeValue,
      enabled: row.enabled,
      managed: true,
      sourceMode: row.sourceMode,
    };
  }, [configQuery.data, historicalView, nativeLabel, nativeValue, variablesQuery.data]);
}
