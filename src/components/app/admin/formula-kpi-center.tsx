"use client";

import { useMemo, useState } from "react";
import {
  Calculator,
  CheckCircle2,
  History,
  Lock,
  Pencil,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import { GlassButton } from "@/components/glass/GlassButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { currentMonthKeyInTz } from "./_shared/business-date";
import { Chip, FilterChips, KpiGrid } from "./_shared/chrome";
import { SearchField, TextAreaField, TextField } from "./_shared/fields";
import { errMessage, useInvalidate } from "./_shared/api";

const KPI_API = "/api/v1/admin/formulas/kpis";
const PREVIEW_API = "/api/v1/admin/formulas/preview";
const VERSIONS_API = "/api/v1/admin/formulas/versions";

type ControlKind = "SYSTEM" | "VARIABLE" | "FORMULA";

type KpiItem = {
  key: string;
  label: string;
  page: string;
  description: string;
  sourceKey: string;
  sourceLabel: string;
  valueRaw: number;
  valueFormatted: string;
  valueType: string;
  unit: string;
  control: ControlKind;
  canEdit: boolean;
  custom: boolean;
  systemLockedReason: string | null;
  formula: null | {
    definitionId: string;
    name: string;
    outputVariableKey: string;
    version: number;
    expressionSource: string;
    humanPreview: string;
    reason: string | null;
  };
  variable: null | {
    key: string;
    category: string;
    editable: boolean;
    description: string;
    usedByFormulas: string[];
  };
};

type KpiResponse = {
  period: { year: number; month: number; key: string };
  isCurrentPeriod: boolean;
  items: KpiItem[];
  meta: { total: number; editable: number; formulas: number; systemFacts: number; custom: number };
  guidance: { instantApply: string; historySafety: string; systemSafety: string };
};

type PreviewResult = {
  formulaText: string;
  humanPreview: string;
  negativeWarning: string | null;
  example: {
    resultMinor: number | null;
    resultFormatted: string;
    divideByZero: boolean;
    divideByZeroMessage: string | null;
  };
};

export default function FormulaKpiCenter({ onOpenWorkbench }: { onOpenWorkbench?: () => void }) {
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const period = currentMonthKeyInTz(tz);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [editing, setEditing] = useState<KpiItem | null>(null);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);

  const query = useApiQuery<KpiResponse>(`${KPI_API}?period=${period}`, undefined, {
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const items = query.data?.items ?? [];
  const meta = query.data?.meta;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "EDITABLE" && !item.canEdit) return false;
      if (filter === "FORMULA" && item.control !== "FORMULA") return false;
      if (filter === "SYSTEM" && item.control !== "SYSTEM") return false;
      if (!q) return true;
      return [item.label, item.page, item.sourceKey, item.sourceLabel, item.description]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [items, search, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, KpiItem[]>();
    for (const item of visible) {
      const rows = map.get(item.page) ?? [];
      rows.push(item);
      map.set(item.page, rows);
    }
    return [...map.entries()];
  }, [visible]);

  function openEditor(item: KpiItem) {
    if (item.control === "VARIABLE") {
      toast.info("This KPI comes from an editable variable", {
        description: "Open Formulas & Variables below, choose Variables, then edit this value.",
      });
      onOpenWorkbench?.();
      window.setTimeout(() => document.getElementById("formula-workbench")?.scrollIntoView({ behavior: "smooth" }), 80);
      return;
    }
    if (item.control !== "FORMULA" || !item.formula) return;
    setEditing(item);
    setDraft(item.formula.expressionSource);
    setReason("");
    setPreview(null);
  }

  async function previewFormula() {
    if (!editing?.formula || !draft.trim()) return;
    setPreviewing(true);
    try {
      const result = await postJson<PreviewResult>(PREVIEW_API, {
        mode: "FORMULA",
        source: draft.trim(),
        outputVariableKey: editing.sourceKey,
        period,
      });
      setPreview(result);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setPreviewing(false);
    }
  }

  async function saveFormula() {
    if (!editing?.formula || !draft.trim() || reason.trim().length < 3) return;
    setSaving(true);
    try {
      await postJson(VERSIONS_API, {
        mode: "FORMULA",
        source: draft.trim(),
        outputVariableKey: editing.sourceKey,
        name: editing.formula.name,
        reason: reason.trim(),
        effective: "CURRENT_OPEN",
        confirmImpact: true,
      });

      invalidate([
        KPI_API,
        "/api/v1/admin/formulas",
        "/api/v1/admin/formulas/variables",
        "/api/v1/admin/dashboard",
        "/api/v1/admin/meals",
        "/api/v1/admin/expenses",
        "/api/v1/admin/payments",
        "/api/v1/admin/funds",
        "/api/v1/admin/billing",
        "/api/v1/admin/bills",
        "/api/v1/billing",
        "/api/v1/meals",
      ]);
      await query.refetch();
      toast.success("Calculation applied", {
        description: "Live/open KPI reads now use the new audited formula version. Generated bills stay frozen.",
      });
      setEditing(null);
      setPreview(null);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <GlassCard className="overflow-hidden p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Calculator className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">KPI Control Center</h2>
                <p className="text-xs text-muted-foreground">See where every important number comes from.</p>
              </div>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Formula KPIs can be changed here. System facts such as cash, payments and meal counts are shown for transparency but stay protected. You can still use those facts inside any formula.
            </p>
          </div>
          <GlassButton variant="secondary" icon={<Settings2 />} onClick={onOpenWorkbench}>
            Formulas & Variables
          </GlassButton>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="glass-inset rounded-xl p-3">
            <div className="flex items-center gap-2 text-xs font-semibold"><Sparkles className="size-4 text-primary" /> Instant apply</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">New formula versions refresh live/open calculations immediately.</p>
          </div>
          <div className="glass-inset rounded-xl p-3">
            <div className="flex items-center gap-2 text-xs font-semibold"><History className="size-4 text-primary" /> History stays safe</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Generated bills keep their frozen formula snapshot.</p>
          </div>
          <div className="glass-inset rounded-xl p-3">
            <div className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck className="size-4 text-primary" /> System facts protected</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Ledger/accounting facts cannot be silently redefined.</p>
          </div>
        </div>
      </GlassCard>

      <KpiGrid
        loading={query.isLoading && !query.data}
        kpis={[
          { label: "KPI Sources", value: String(meta?.total ?? 0), icon: <Calculator />, tone: "primary", glow: "primary", sub: "Visible calculations" },
          { label: "Editable", value: String(meta?.editable ?? 0), icon: <Pencil />, tone: "success", glow: "success", sub: "Safe to configure" },
          { label: "Protected", value: String(meta?.systemFacts ?? 0), icon: <Lock />, tone: "neutral", glow: "neutral", sub: "System facts" },
        ]}
      />

      <GlassCard className="p-4">
        <div className="space-y-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search KPI, page or source…" />
          <FilterChips
            chips={[
              { value: "ALL", label: "All" },
              { value: "EDITABLE", label: "Editable" },
              { value: "FORMULA", label: "Formulas" },
              { value: "SYSTEM", label: "Protected" },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </div>

        <div className="mt-4 space-y-5">
          {grouped.map(([page, pageItems]) => (
            <section key={page}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{page}</h3>
                <Chip tone="frost">{pageItems.length} KPI{pageItems.length === 1 ? "" : "s"}</Chip>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {pageItems.map((item) => (
                  <div key={item.key} className="glass-inset rounded-2xl p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate text-sm font-semibold">{item.label}</p>
                          <Chip tone={item.control === "FORMULA" ? "frost" : item.control === "VARIABLE" ? "neutral" : "neutral"}>
                            {item.control === "FORMULA" ? "Formula" : item.control === "VARIABLE" ? "Editable value" : "System"}
                          </Chip>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.description}</p>
                      </div>
                      {item.control === "SYSTEM" && <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                    </div>

                    <div className="mt-3 flex items-end justify-between gap-3 border-t border-border/40 pt-3">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Current value</p>
                        <p className="kpi-num mt-0.5 truncate text-lg font-bold">{item.valueFormatted}</p>
                        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={item.sourceKey}>
                          source: {item.sourceKey}
                        </p>
                      </div>

                      {item.canEdit ? (
                        <GlassButton size="sm" variant="secondary" icon={<Pencil />} onClick={() => openEditor(item)}>
                          {item.control === "FORMULA" ? "Edit calculation" : "Edit value"}
                        </GlassButton>
                      ) : (
                        <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Protected</span>
                      )}
                    </div>

                    {item.formula && (
                      <div className="mt-2 rounded-xl bg-background/35 px-2.5 py-2">
                        <p className="text-[10px] font-semibold text-muted-foreground">v{item.formula.version}</p>
                        <p className="mt-0.5 break-words font-mono text-[11px] leading-relaxed">{item.formula.expressionSource}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}

          {!query.isLoading && grouped.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No KPI sources match your search.</div>
          )}
        </div>
      </GlassCard>

      <Dialog open={editing != null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="glass-strong rounded-2xl border-0 sm:max-w-xl">
          {editing?.formula && (
            <div className="space-y-4">
              <div>
                <DialogTitle>Edit {editing.label}</DialogTitle>
                <DialogDescription className="mt-1.5">
                  Preview the calculation, then apply it. Saving creates a new audited version; old generated bills do not change.
                </DialogDescription>
              </div>

              <div className="glass-inset rounded-xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">Current</span>
                  <span className="kpi-num font-bold">{editing.valueFormatted}</span>
                </div>
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{editing.formula.expressionSource}</p>
              </div>

              <TextAreaField
                label="Calculation"
                value={draft}
                onChange={(value) => {
                  setDraft(value);
                  setPreview(null);
                }}
                rows={4}
                placeholder="e.g. (total_meal_expense - total_guest_income) / total_resident_meals"
              />
              <TextField label="Reason for change" value={reason} onChange={setReason} placeholder="e.g. Use Meal Cost classification for billing" maxLength={500} />

              {preview && (
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-xs font-semibold"><CheckCircle2 className="size-4 text-primary" /> Preview result</span>
                    <span className="kpi-num text-lg font-bold">{preview.example.resultFormatted}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{preview.humanPreview}</p>
                  {preview.example.divideByZero && <p className="mt-2 text-xs font-medium text-danger">{preview.example.divideByZeroMessage}</p>}
                  {preview.negativeWarning && <p className="mt-2 text-xs font-medium text-danger">{preview.negativeWarning}</p>}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-3">
                <GlassButton variant="ghost" onClick={() => setEditing(null)}>Cancel</GlassButton>
                <GlassButton variant="secondary" loading={previewing} icon={<Search />} onClick={() => void previewFormula()} disabled={!draft.trim()}>
                  Preview
                </GlassButton>
                <GlassButton
                  variant="primary"
                  loading={saving}
                  icon={<Sparkles />}
                  onClick={() => void saveFormula()}
                  disabled={!draft.trim() || reason.trim().length < 3 || preview?.example.divideByZero === true}
                >
                  Save & apply now
                </GlassButton>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
