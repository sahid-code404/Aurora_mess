"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Calculator,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  Gauge,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import MealOrb from "@/components/glass/MealOrb";
import { GlassButton } from "@/components/glass/GlassButton";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ErrorState from "@/components/glass/ErrorState";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { ApiClientError } from "@/lib/api";
import { currentMonthKeyInTz } from "./_shared/business-date";
import { errMessage, useInvalidate } from "./_shared/api";
import { DetailDialog, FilterChips } from "./_shared/chrome";
import { SearchField, SelectField, TextAreaField, TextField } from "./_shared/fields";

const KPI_API = "/api/v1/admin/formulas/kpis";

type KpiRow = {
  key: string;
  surface: string;
  surfaceLabel: string;
  nativeLabel: string;
  label: string;
  description: string;
  enabled: boolean;
  sourceMode: "NATIVE" | "VARIABLE";
  sourceVariableKey: string | null;
  sourceDisplayName: string | null;
  sourceCategory: string | null;
  sourceKind: "FORMULA" | "VARIABLE" | null;
  sourceAvailable: boolean;
  valueRaw: number | null;
  valueFormatted: string | null;
  isConfigured: boolean;
};

type KpiSource = {
  key: string;
  displayName: string;
  description: string;
  category: "SYSTEM" | "CUSTOM" | "DERIVED" | string;
  sourceKind: "FORMULA" | "VARIABLE";
  valueType: string;
  unit: string;
  valueRaw: number;
  valueFormatted: string;
};

type KpiApiData = {
  period: { year: number; month: number; key: string };
  configurationVersion: number;
  configurationUpdatedAt: string | null;
  kpis: KpiRow[];
  sources?: KpiSource[];
  surfaces: { key: string; label: string }[];
};

function sourceLabel(row: KpiRow): string {
  if (row.sourceMode === "NATIVE") return "Built-in";
  return row.sourceKind === "FORMULA" ? "Formula" : "Variable";
}

function SourceBadge({ row }: { row: KpiRow }) {
  const isFormula = row.sourceKind === "FORMULA";
  return (
    <span
      className={
        row.sourceMode === "NATIVE"
          ? "inline-flex rounded-pill border border-border/70 bg-muted/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
          : isFormula
            ? "inline-flex rounded-pill border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
            : "inline-flex rounded-pill border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success"
      }
    >
      {sourceLabel(row)}
    </span>
  );
}

export default function FormulaKpiControls() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const period = currentMonthKeyInTz(tz);
  const invalidate = useInvalidate();
  const [surface, setSurface] = useState("ALL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<KpiRow | null>(null);

  const query = useApiQuery<KpiApiData>(KPI_API, { period, includeSources: 1 }, {
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const rows = query.data?.kpis ?? [];
  const sources = query.data?.sources ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (surface !== "ALL" && row.surface !== surface) return false;
      if (!q) return true;
      return [row.label, row.nativeLabel, row.surfaceLabel, row.sourceDisplayName ?? "", row.sourceVariableKey ?? ""]
        .some((value) => value.toLowerCase().includes(q));
    });
  }, [rows, search, surface]);

  const surfaceChips = [
    { value: "ALL", label: "All", count: rows.length },
    ...(query.data?.surfaces ?? []).map((item) => ({
      value: item.key,
      label: item.label,
      count: rows.filter((row) => row.surface === item.key).length,
    })),
  ];

  function refreshEveryKpiSurface() {
    invalidate([
      KPI_API,
      "/api/v1/admin/dashboard",
      "/api/v1/admin/expenses",
      "/api/v1/admin/payments",
      "/api/v1/admin/funds",
      "/api/v1/admin/billing",
      "/api/v1/admin/bills",
      "/api/v1/admin/residents",
      "/api/v1/admin/tasks",
      "/api/v1/admin/audit",
      "/api/v1/admin/formulas",
      "/api/v1/admin/formulas/variables",
    ]);
  }

  if (query.error && !query.data) {
    return (
      <ErrorState
        code={(query.error as ApiClientError).code}
        message={(query.error as ApiClientError).message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <>
      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Gauge className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-semibold">KPI Controls</h3>
              <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
                Choose what each KPI card shows. Keep <strong>Built-in</strong> for the normal trusted BoardOps value, or connect a Variable/Formula for a custom live calculation.
              </p>
            </div>
          </div>
          <span className="rounded-pill border border-success/25 bg-success/10 px-2.5 py-1 text-[10px] font-semibold text-success">
            Live · {period}
          </span>
        </div>

        <div className="mb-3 space-y-2.5 border-t border-border/40 pt-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search KPI, page or calculation…" />
          <FilterChips chips={surfaceChips} value={surface} onChange={setSurface} layoutId="formula-kpi-surfaces" />
        </div>

        {query.isLoading && !query.data ? (
          <ListSkeleton rows={5} />
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No KPI cards match this filter.</div>
        ) : (
          <div className="space-y-2">
            {filtered.map((row, index) => {
              const Icon = row.sourceKind === "FORMULA" ? Calculator : row.sourceMode === "VARIABLE" ? Database : SlidersHorizontal;
              return (
                <motion.div
                  key={row.key}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(index * 0.025, 0.15) }}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(row)}
                    className="glass-inset flex w-full items-center justify-between gap-3 rounded-xl p-3 text-left transition-all hover:ring-1 hover:ring-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <MealOrb icon={<Icon />} colorToken={row.enabled ? "frost" : "rose"} size="sm" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{row.label}</span>
                          <SourceBadge row={row} />
                          {!row.enabled && (
                            <span className="inline-flex items-center gap-1 rounded-pill bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger">
                              <EyeOff className="size-3" /> Hidden
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {row.surfaceLabel}
                          {row.sourceMode === "VARIABLE" && row.sourceDisplayName ? ` · ${row.sourceDisplayName}` : " · BoardOps page value"}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <div className="hidden text-right sm:block">
                        <span className="kpi-num block text-sm font-semibold text-foreground">
                          {row.sourceMode === "VARIABLE" ? row.valueFormatted ?? "—" : "Built-in"}
                        </span>
                        <span className="text-[10px] text-muted-foreground">current</span>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                    </div>
                  </button>
                </motion.div>
              );
            })}
          </div>
        )}

        <div className="mt-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <strong className="text-foreground">Safe by design:</strong> changing a KPI only changes what that card displays. It cannot redefine ledger cash, payment status, generated bills, refunds or frozen billing history. Historical month views keep their stored/native values.
        </div>
      </GlassCard>

      {selected && (
        <KpiEditorDialog
          key={`${selected.key}-${query.data?.configurationVersion ?? 0}`}
          row={selected}
          sources={sources}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            refreshEveryKpiSurface();
            await query.refetch();
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function KpiEditorDialog({
  row,
  sources,
  onClose,
  onSaved,
}: {
  row: KpiRow;
  sources: KpiSource[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [label, setLabel] = useState(row.label);
  const [visible, setVisible] = useState(row.enabled ? "SHOW" : "HIDE");
  const [source, setSource] = useState(row.sourceMode === "VARIABLE" && row.sourceVariableKey ? row.sourceVariableKey : "__NATIVE__");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedSource = source === "__NATIVE__" ? null : sources.find((item) => item.key === source) ?? null;
  const options = [
    { value: "__NATIVE__", label: "Built-in BoardOps value (recommended when unsure)" },
    ...sources.map((item) => ({
      value: item.key,
      label: `${item.sourceKind === "FORMULA" ? "Formula" : "Variable"} · ${item.displayName}`,
    })),
  ];

  async function save() {
    if (!label.trim()) return toast.error("KPI name is required");
    setSaving(true);
    try {
      await postJson(KPI_API, {
        key: row.key,
        label: label.trim(),
        enabled: visible === "SHOW",
        sourceMode: source === "__NATIVE__" ? "NATIVE" : "VARIABLE",
        sourceVariableKey: source === "__NATIVE__" ? null : source,
        reason: reason.trim() || undefined,
      });
      toast.success("KPI saved and applied", {
        description:
          source === "__NATIVE__"
            ? `${label.trim()} now uses the page's built-in value.`
            : `${label.trim()} now uses ${selectedSource?.displayName ?? source}.`,
      });
      await onSaved();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit KPI · ${row.nativeLabel}`}
      description={`${row.surfaceLabel} · Changes are versioned and written to the Admin audit trail.`}
      footer={
        <>
          <GlassButton variant="ghost" onClick={onClose} disabled={saving}>Cancel</GlassButton>
          <GlassButton variant="primary" icon={<Save />} loading={saving} onClick={() => void save()}>
            Save &amp; Apply
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="KPI name"
          value={label}
          onChange={setLabel}
          maxLength={50}
          hint="Use a short name that is easy to understand on the page."
        />

        <SelectField
          label="What should this KPI show?"
          value={source}
          onChange={setSource}
          options={options}
          hint={
            selectedSource
              ? `${selectedSource.sourceKind === "FORMULA" ? "Formula" : "Variable"}: ${selectedSource.description} Current value: ${selectedSource.valueFormatted}.`
              : "Built-in keeps the page's existing trusted calculation."
          }
        />

        <SelectField
          label="Show this KPI?"
          value={visible}
          onChange={setVisible}
          options={[
            { value: "SHOW", label: "Yes — show this KPI" },
            { value: "HIDE", label: "No — hide this KPI" },
          ]}
          hint="Hiding a KPI only removes the card from the page; it does not delete any data or formula."
        />

        <TextAreaField
          label="Audit note (optional)"
          value={reason}
          onChange={setReason}
          rows={2}
          maxLength={500}
          placeholder="e.g. Show meal cost directly from the new formula"
          hint="BoardOps records the before and after settings even when this note is empty."
        />

        <div className="glass-inset rounded-xl p-3">
          <div className="flex items-start gap-2">
            {visible === "SHOW" ? <Eye className="mt-0.5 size-4 shrink-0 text-success" /> : <EyeOff className="mt-0.5 size-4 shrink-0 text-danger" />}
            <div className="min-w-0 text-[12px] leading-relaxed">
              <p className="font-semibold text-foreground">What happens after Save &amp; Apply</p>
              <p className="mt-0.5 text-muted-foreground">
                Current live Admin pages use this setting immediately. If the source is a Formula, future formula edits flow into this KPI automatically. Past/frozen billing periods keep their original values.
              </p>
            </div>
          </div>
        </div>
      </div>
    </DetailDialog>
  );
}
