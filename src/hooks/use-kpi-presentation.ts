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

  const query = useApiQuery<KpiSurfaceData>(surface ? "/api/v1/admin/formulas/kpis" : null, {
    surface: surface ?? undefined,
  }, {
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  return useMemo(() => {
    const row = query.data?.kpis.find((item) => item.nativeLabel === nativeLabel) ?? null;
    if (!row) {
      return {
        label: nativeLabel,
        value: nativeValue,
        enabled: true,
        managed: false,
        sourceMode: "NATIVE" as const,
      };
    }

    const canUseLiveSource =
      !historicalView &&
      row.sourceMode === "VARIABLE" &&
      row.sourceAvailable &&
      row.valueFormatted != null;

    return {
      label: row.label || nativeLabel,
      value: canUseLiveSource ? row.valueFormatted : nativeValue,
      enabled: row.enabled,
      managed: true,
      sourceMode: row.sourceMode,
    };
  }, [historicalView, nativeLabel, nativeValue, query.data]);
}
