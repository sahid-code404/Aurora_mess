"use client";

/**
 * Admin Formulas & Variable Engine — BoardOps composition & design language.
 * Follows the standard admin page anatomy:
 * Month capsule (PickerCapsule) → KPIs (KpiGrid) → Action bar → ONE section card
 * holding Formulas Workbench and Variables Registry with internal FilterChips.
 *
 * Route: /admin/formula-engine & /admin/formulas
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  BookOpen,
  Calculator,
  Calendar,
  Check,
  ChevronRight,
  Code2,
  Copy,
  DollarSign,
  Eye,
  FileSpreadsheet,
  Hash,
  History,
  Layers,
  Lock,
  Pencil,
  Pin,
  Plus,
  ReceiptText,
  Save,
  Search,
  Sigma,
  Sparkles,
  Tag,
  Trash2,
  Users,
  Utensils,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { errMessage, useInvalidate } from "./_shared/api";
import { SearchField, SelectField, TextAreaField, TextField } from "./_shared/fields";
import { Chip, DetailDialog, FilterChips, KpiGrid, KeyValue } from "./_shared/chrome";
import { monthLabel, todayKey } from "./_shared/format";
import type {
  FormulaDefinitionItem,
  FormulaExplanationData,
  FormulaPreviewResult,
  FormulaVersion,
  VariableItem,
} from "./_shared/types";

const FORMULAS_API = "/api/v1/admin/formulas";
const VARIABLES_API = "/api/v1/admin/formulas/variables";
const CUSTOM_VARS_API = "/api/v1/admin/formulas/custom-variables";
const PREVIEW_API = "/api/v1/admin/formulas/preview";
const VERSIONS_API = "/api/v1/admin/formulas/versions";
const PIN_API = "/api/v1/admin/formulas/pin";

/** "2026-09" ± 1 → "2026-08" / "2026-10" (BoardOps month helper). */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Long month name for PickerCapsule ("September"). */
function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2026, (m ?? 1) - 1, 1));
}

const VARIABLE_ALIASES: Record<string, string> = {
  total_market_cost: "total_market_expense",
  total_consumed_resident_meals: "total_resident_meals",
  total_resident_meals_on: "total_resident_meals",
  resident_count: "total_residents",
  total_active_residents: "total_residents",
  total_expense: "total_approved_expense",
  remaining_funds: "available_funds",
  total_collected: "total_payments_approved",
  billing_period_days: "days_in_month",
};

/** Substitutes exact numerical values of variables into the formula expression (e.g. (2750 - 220) / 57 = 44.39). */
function formatEvaluatedFormula(
  expressionSource: string,
  variables: any[],
  fallbackVars: VariableItem[],
  resultFormatted?: string,
  resultMinor?: number | null
): string {
  const varMap = new Map<string, number>();

  for (const v of fallbackVars || []) {
    const isMoney = v.valueType === "MONEY" || v.unit === "INR" || /expense|income|price|salary|cost|funds|payment|balance/i.test(v.key);
    const num = isMoney ? Number((v.valueRaw / 100).toFixed(2)) : v.valueRaw;
    varMap.set(v.key, num);
  }

  for (const v of variables || []) {
    const isMoney = v.unit === "INR" || v.valueType === "MONEY" || /expense|income|price|salary|cost|funds|payment|balance/i.test(v.name);
    const num = isMoney ? Number((v.value / 100).toFixed(2)) : v.value;
    varMap.set(v.name, num);
  }

  const replaced = expressionSource.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, (match) => {
    const canonicalKey = VARIABLE_ALIASES[match] || match;
    if (varMap.has(canonicalKey)) {
      return String(varMap.get(canonicalKey));
    }
    if (varMap.has(match)) {
      return String(varMap.get(match));
    }
    return match;
  });

  const resVal =
    resultMinor !== null && resultMinor !== undefined
      ? Number((resultMinor / 100).toFixed(2))
      : resultFormatted?.replace(/^[₹$\s]+/, "") ?? "";

  return `${replaced} = ${resVal}`;
}

export default function AdminFormulas() {
  const invalidate = useInvalidate();
  const { institution } = useSession();

  const thisMonthKey = todayKey().slice(0, 7);
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const activeMonthKey = monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;

  // View state: Formulas vs Variables
  const [activeTab, setActiveTab] = useState<"formulas" | "variables">("formulas");
  const [selectedFormulaKey, setSelectedFormulaKey] = useState<string>("meal_charge");
  const [variableCategory, setVariableCategory] = useState<string>("ALL");
  const [variableSearch, setVariableSearch] = useState("");
  const [formulaSearch, setFormulaSearch] = useState("");
  const [formulaFilter, setFormulaFilter] = useState("ALL");

  // Dialogs
  const [createVarOpen, setCreateVarOpen] = useState(false);
  const [formulaModalConfig, setFormulaModalConfig] = useState<{
    open: boolean;
    isNew: boolean;
    formula?: FormulaDefinitionItem | null;
    activeVersion?: FormulaVersion | null;
  }>({ open: false, isNew: false });

  const [inspectFormula, setInspectFormula] = useState<FormulaDefinitionItem | null>(null);
  const [inspectVar, setInspectVar] = useState<VariableItem | null>(null);
  const [editingVar, setEditingVar] = useState<VariableItem | null>(null);
  const [manageValuesVar, setManageValuesVar] = useState<VariableItem | null>(null);
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Queries — auto-refresh every 30s so formulas & variables stay in sync with live data
  const formulasQuery = useApiQuery<{
    definitions: FormulaDefinitionItem[];
    selectedDefinition: FormulaDefinitionItem | null;
    activeVersion: FormulaVersion | null;
    history: FormulaVersion[];
    currentPeriod: { year: number; month: number; key: string };
    currentPeriodVersion: FormulaVersion | null;
    estimate: any;
  }>(`${FORMULAS_API}?outputVariable=${selectedFormulaKey}&period=${activeMonthKey}`, undefined, {
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const variablesQuery = useApiQuery<{
    period: { year: number; month: number; key: string };
    variables: VariableItem[];
    functions: { fn: string; label: string; description: string }[];
    operators: string[];
  }>(`${VARIABLES_API}?period=${activeMonthKey}`, undefined, {
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const active = formulasQuery.data?.activeVersion;
  const currentDef = formulasQuery.data?.selectedDefinition;
  const estimate = formulasQuery.data?.estimate;
  const allVars = variablesQuery.data?.variables ?? [];
  const definitions = formulasQuery.data?.definitions ?? [];

  // Counts for KPIs
  const systemCount = allVars.filter((v) => v.category === "SYSTEM").length;
  const customCount = allVars.filter((v) => v.category === "CUSTOM").length;
  const editableCount = allVars.filter((v) => v.isEditable).length;

  // Evaluated calculation showing exact variable values e.g. (2750 - 220) / 57 = 44.39
  const evaluatedEquation = useMemo(() => {
    if (!active?.expressionSource) return "";
    return formatEvaluatedFormula(
      active.expressionSource,
      estimate?.variables ?? [],
      allVars,
      estimate?.resultFormatted,
      estimate?.resultMinor
    );
  }, [active?.expressionSource, estimate?.variables, allVars, estimate?.resultFormatted, estimate?.resultMinor]);

  // Filter variables
  const filteredVariables = useMemo(() => {
    return allVars.filter((v) => {
      if (variableCategory === "SYSTEM" && v.category !== "SYSTEM") return false;
      if (variableCategory === "CUSTOM" && v.category !== "CUSTOM") return false;
      if (variableCategory === "DERIVED" && v.category !== "DERIVED") return false;
      if (variableCategory === "PINNED" && !v.isPinned) return false;
      if (variableCategory === "EDITABLE" && !v.isEditable) return false;

      if (!variableSearch.trim()) return true;
      const q = variableSearch.toLowerCase();
      return (
        v.displayName.toLowerCase().includes(q) ||
        v.key.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q)
      );
    });
  }, [allVars, variableCategory, variableSearch]);

  // Filter formulas
  const filteredFormulas = useMemo(() => {
    return definitions.filter((f) => {
      if (formulaFilter === "ACTIVE" && f.status !== "ACTIVE") return false;
      if (formulaFilter === "DRAFT" && f.status !== "DRAFT") return false;
      if (!formulaSearch.trim()) return true;
      const q = formulaSearch.toLowerCase();
      return (
        f.name.toLowerCase().includes(q) ||
        f.outputVariableKey.toLowerCase().includes(q) ||
        (f.description && f.description.toLowerCase().includes(q))
      );
    });
  }, [definitions, formulaFilter, formulaSearch]);

  // Instantly apply variable & formula changes in all appropriate areas
  async function refreshAllAreas() {
    await Promise.allSettled([
      formulasQuery.refetch(),
      variablesQuery.refetch(),
    ]);
    invalidate([
      FORMULAS_API,
      VARIABLES_API,
      CUSTOM_VARS_API,
      PREVIEW_API,
      VERSIONS_API,
      "/api/v1/admin/formulas",
      "/api/v1/admin/formulas/variables",
      "/api/v1/admin/formulas/custom-variables",
      "/api/v1/admin/formulas/explain",
      "/api/v1/admin/meal-configuration",
      "/api/v1/admin/settings",
      "/api/v1/admin/meals",
      "/api/v1/admin/billing",
      "/api/v1/admin/bills",
      "/api/v1/billing",
      "/api/v1/meals",
      "/api/v1/guest-meals",
    ]);
  }

  // Pin variable
  async function togglePin(varKey: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await postJson(PIN_API, { variableKey: varKey });
      toast.success("Variable pinned status updated");
      void refreshAllAreas();
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  if (formulasQuery.error && !formulasQuery.data) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={(formulasQuery.error as ApiClientError).code}
          message={(formulasQuery.error as ApiClientError).message}
          onRetry={() => void formulasQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <StaggerGroup className="space-y-4">
      {/* 1. MONTH CAPSULE — circular arrows + reset pill (Standard BoardOps Picker) */}
      <StaggerItem>
        <PickerCapsule
          onPrev={() => setMonthParam(shiftMonthKey(activeMonthKey, -1))}
          onNext={() => setMonthParam(shiftMonthKey(activeMonthKey, 1))}
          prevLabel="Previous month"
          nextLabel="Next month"
          onPillClick={() => setMonthParam(undefined)}
          pillAriaLabel="Reset to current month"
          resettable={!isThisMonth}
        >
          <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 text-center leading-tight">
            <span className="block truncate text-sm font-bold text-primary">{monthLongName(activeMonthKey)}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{activeMonthKey.slice(0, 4)}</span>
          </span>
        </PickerCapsule>
      </StaggerItem>

      {/* 2. KPIS — Standard BoardOps 3-KPI Grid */}
      <StaggerItem>
        <KpiGrid
          loading={formulasQuery.isLoading && !formulasQuery.data}
          className="grid grid-cols-3 gap-2 sm:gap-3"
          kpis={[
            {
              label: "Meal Charge",
              value: estimate?.resultFormatted ?? "—",
              icon: <Sigma />,
              tone: "primary",
              glow: "primary",
              sub: `${monthLongName(activeMonthKey)} rate`,
            },
            {
              label: "Formulas",
              value: String(definitions.length || 1),
              icon: <Calculator />,
              tone: "success",
              glow: "success",
              sub: "Calculated outputs",
            },
            {
              label: "Parameters",
              value: String(allVars.length || 36),
              icon: <Tag />,
              tone: "warning",
              glow: "warning",
              sub: `${editableCount} editable`,
            },
          ]}
        />
      </StaggerItem>

      {/* 3. TABS (OUTER THE BORDER — NO COUNTS) */}
      <StaggerItem>
        <div className="flex items-center justify-center">
          <FilterChips
            chips={[
              { value: "formulas", label: "Formulas" },
              { value: "variables", label: "Variables" },
            ]}
            value={activeTab}
            onChange={(v) => setActiveTab(v as any)}
            className="justify-center"
          />
        </div>
      </StaggerItem>

      {/* 4. MAIN SECTION CARD */}
      <StaggerItem>
        <GlassCard className="p-4">
          {/* Card Header: Action Button Centered (No Formulas/Variables words) */}
          <div className="mb-3 flex items-center justify-center border-b border-border/40 pb-3">
            {activeTab === "formulas" ? (
              <GlassButton
                variant="primary"
                size="sm"
                icon={<Plus className="size-4" />}
                onClick={() =>
                  setFormulaModalConfig({
                    open: true,
                    isNew: true,
                    formula: null,
                    activeVersion: null,
                  })
                }
              >
                New Formula
              </GlassButton>
            ) : (
              <GlassButton
                variant="primary"
                size="sm"
                icon={<Plus className="size-4" />}
                onClick={() => setCreateVarOpen(true)}
              >
                New Variable
              </GlassButton>
            )}
          </div>

          {/* TAB 1: FORMULAS WORKBENCH (DESIGNED LIKE VARIABLES WINDOW) */}
          {activeTab === "formulas" && (
            <div className="space-y-3">
              {/* Search Field & FilterChips */}
              <div className="space-y-2">
                <SearchField
                  value={formulaSearch}
                  onChange={setFormulaSearch}
                  placeholder="Search formulas (name, output key, description)..."
                />

                <FilterChips
                  chips={[
                    { value: "ALL", label: "All" },
                    { value: "ACTIVE", label: "Active" },
                    { value: "DRAFT", label: "Draft" },
                  ]}
                  value={formulaFilter}
                  onChange={setFormulaFilter}
                />
              </div>

              {/* Formulas Row Items (Matching Payments & Variables Row Anatomy with Symmetrical Heights & Hover Lift) */}
              <div className="space-y-2 pt-1">
                {filteredFormulas.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    No formulas found matching &quot;{formulaSearch}&quot;
                  </div>
                ) : (
                  filteredFormulas.map((f, i) => {
                    const isCharge = f.outputVariableKey.includes("charge");
                    return (
                      <motion.div
                        key={f.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        whileHover={{ y: -2, transition: { duration: 0.18 } }}
                        transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                      >
                        <GlassCard className="group overflow-hidden rounded-2xl transition-all duration-200 hover:shadow-lg hover:shadow-primary/10 hover:border-primary/40">
                          <div
                            className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                            onClick={() => {
                              setSelectedFormulaKey(f.outputVariableKey);
                              setInspectFormula(f);
                            }}
                          >
                            {/* Top row: Identity & Key (Left), Rate / Value (Right) — symmetrical balance */}
                            <div className="flex h-10 items-center justify-between gap-3">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <MealOrb icon={<Calculator />} colorToken={isCharge ? "emerald" : "sky"} size="sm" />
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                                      {f.name}
                                    </h4>
                                    <StatusBadge status={f.status} />
                                    {f.activeVersion && (
                                      <Chip tone="neutral" className="text-[10px] px-1.5 py-0.5">
                                        v{f.activeVersion.version}
                                      </Chip>
                                    )}
                                  </div>
                                  <p className="kpi-num mt-0.5 text-xs font-mono text-muted-foreground truncate">
                                    output: <span className="font-semibold text-primary">{f.outputVariableKey}</span>
                                  </p>
                                </div>
                              </div>

                              <div className="text-right shrink-0">
                                <span className="font-mono text-base sm:text-lg font-bold text-emerald-400 block leading-tight">
                                  {f.outputVariableKey === selectedFormulaKey ? (estimate?.resultFormatted ?? "—") : "Active"}
                                </span>
                                <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                                  {isCharge ? "per meal" : "calculated rate"}
                                </span>
                              </div>
                            </div>

                            {/* Bottom row: Badges on left, Details in a pill on right — strictly h-7 for symmetrical heights */}
                            <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                              <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                                {f.description ? (
                                  <span className="text-[11px] text-muted-foreground truncate max-w-[220px]" title={f.description}>
                                    {f.description}
                                  </span>
                                ) : f.activeVersion?.humanPreview ? (
                                  <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[240px]">
                                    {f.activeVersion.humanPreview}
                                  </span>
                                ) : null}
                              </div>

                              {/* Details button in a tactile glass pill with hover animation */}
                              <motion.button
                                type="button"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.94 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedFormulaKey(f.outputVariableKey);
                                  setInspectFormula(f);
                                }}
                                aria-label={`Open details for formula ${f.name}`}
                                className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2"
                              >
                                <span>Details</span>
                                <ChevronRight className="size-3" aria-hidden />
                              </motion.button>
                            </div>
                          </div>
                        </GlassCard>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* TAB 2: VARIABLES REGISTRY (WITH DETAILS PILL & HOVER ANIMATION) */}
          {activeTab === "variables" && (
            <div className="space-y-3">
              {/* Search Field & Category FilterChips */}
              <div className="space-y-2">
                <SearchField
                  value={variableSearch}
                  onChange={setVariableSearch}
                  placeholder="Search variables (name, key, description)..."
                />

                <FilterChips
                  chips={[
                    { value: "ALL", label: "All", count: allVars.length },
                    { value: "SYSTEM", label: "System", count: systemCount },
                    { value: "CUSTOM", label: "Custom", count: customCount },
                    { value: "EDITABLE", label: "Editable", count: editableCount },
                    { value: "PINNED", label: "Pinned" },
                  ]}
                  value={variableCategory}
                  onChange={setVariableCategory}
                />
              </div>

              {/* Variable Row Items (BoardOps Row Anatomy with Symmetrical Heights & Hover Lift) */}
              <div className="space-y-2 pt-1">
                {filteredVariables.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    No variables found matching &quot;{variableSearch}&quot;
                  </div>
                ) : (
                  filteredVariables.map((v, i) => {
                    const isCustom = v.category === "CUSTOM";
                    const isDerived = v.category === "DERIVED";
                    const isMoney = v.valueType === "MONEY" || v.unit === "INR";
                    const orbColor = isCustom ? "amber" : isDerived ? "teal" : isMoney ? "emerald" : "sky";
                    const OrbIcon = isMoney ? Banknote : isDerived ? Sigma : isCustom ? Tag : Hash;

                    return (
                      <motion.div
                        key={v.key}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        whileHover={{ y: -2, transition: { duration: 0.18 } }}
                        transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                      >
                        <GlassCard className="group overflow-hidden rounded-2xl transition-all duration-200 hover:shadow-lg hover:shadow-primary/10 hover:border-primary/40">
                          <div
                            className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                            onClick={() => setInspectVar(v)}
                          >
                            {/* Top row: Orb + Name + Key (Left), Value (Right) — symmetrical balance */}
                            <div className="flex h-10 items-center justify-between gap-3">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <MealOrb icon={<OrbIcon />} colorToken={orbColor} size="sm" />
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                                      {v.displayName}
                                    </h4>
                                    <span
                                      className={cn(
                                        "rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider",
                                        isCustom
                                          ? "bg-amber-500/15 text-amber-400"
                                          : isDerived
                                          ? "bg-teal-500/15 text-teal-400"
                                          : "bg-sky-500/15 text-sky-400"
                                      )}
                                    >
                                      {v.category}
                                    </span>
                                    {v.isEditable && (
                                      <span className="rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-emerald-400">
                                        Editable
                                      </span>
                                    )}
                                  </div>
                                  <p className="kpi-num mt-0.5 text-xs font-mono text-muted-foreground truncate">
                                    {v.key}
                                  </p>
                                </div>
                              </div>

                              <div className="text-right shrink-0">
                                <span className="font-mono text-base sm:text-lg font-bold text-emerald-400 block leading-tight">
                                  {v.valueFormatted}
                                </span>
                                <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                                  {v.unit ?? (isMoney ? "INR" : "count")}
                                </span>
                              </div>
                            </div>

                            {/* Bottom row: Edit / Pin on left, Details in a pill on right — strictly h-7 for symmetrical heights */}
                            <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                              <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                                {v.description && (
                                  <span className="text-[11px] text-muted-foreground truncate max-w-[200px]" title={v.description}>
                                    {v.description}
                                  </span>
                                )}
                                {v.isEditable && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingVar(v);
                                    }}
                                    className="flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-primary hover:bg-primary/15 transition-colors"
                                    title={`Edit ${v.displayName}`}
                                  >
                                    <Pencil className="size-3" />
                                    <span>Edit</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => togglePin(v.key, e)}
                                  className={cn(
                                    "flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors hover:bg-white/10",
                                    v.isPinned ? "text-amber-400" : "text-muted-foreground"
                                  )}
                                  title={v.isPinned ? "Unpin" : "Pin"}
                                >
                                  <Pin className="size-3" />
                                  <span>{v.isPinned ? "Pinned" : "Pin"}</span>
                                </button>
                              </div>

                              {/* Details button in a tactile glass pill with hover animation */}
                              <motion.button
                                type="button"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.94 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setInspectVar(v);
                                }}
                                aria-label={`Open details for variable ${v.displayName}`}
                                className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2"
                              >
                                <span>Details</span>
                                <ChevronRight className="size-3" aria-hidden />
                              </motion.button>
                            </div>
                          </div>
                        </GlassCard>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </GlassCard>
      </StaggerItem>

      {/* =========================================================
          MODALS & DIALOGS (BoardOps DetailDialog Standard)
          ========================================================= */}

      {/* 0. FORMULA DETAILS DIALOG */}
      {inspectFormula && (
        <FormulaDetailsDialog
          open
          formula={inspectFormula}
          activeVersion={inspectFormula.activeVersion ?? (inspectFormula.outputVariableKey === selectedFormulaKey ? active : null) ?? null}
          periodKey={activeMonthKey}
          estimate={estimate}
          allVars={allVars}
          onOpenChange={(op) => !op && setInspectFormula(null)}
          onEdit={() => {
            setFormulaModalConfig({
              open: true,
              isNew: false,
              formula: inspectFormula,
              activeVersion: inspectFormula.activeVersion ?? active,
            });
            setInspectFormula(null);
          }}
          onExplain={() => {
            setExplanationOpen(true);
            setInspectFormula(null);
          }}
          onHistory={() => {
            setHistoryOpen(true);
            setInspectFormula(null);
          }}
        />
      )}

      {/* 1. DUAL-OPTION FORMULA CREATOR / EDITOR DIALOG */}
      {formulaModalConfig.open && (
        <FormulaEditorDialog
          open={formulaModalConfig.open}
          isNew={formulaModalConfig.isNew}
          initialDefinition={formulaModalConfig.formula ?? null}
          initialVersion={formulaModalConfig.activeVersion ?? null}
          periodKey={activeMonthKey}
          allVariables={allVars}
          onOpenChange={(op) => {
            if (!op) setFormulaModalConfig({ open: false, isNew: false });
          }}
          onSuccess={async (key) => {
            setSelectedFormulaKey(key);
            await refreshAllAreas();
            setFormulaModalConfig({ open: false, isNew: false });
          }}
        />
      )}

      {/* 2. DIRECT VARIABLE VALUE EDITOR (Guest meal price, deficit, customs) */}
      {editingVar && (
        <EditVariableValueDialog
          open
          variable={editingVar}
          currentPeriodKey={activeMonthKey}
          onOpenChange={(op) => !op && setEditingVar(null)}
          onSuccess={async () => {
            await refreshAllAreas();
            setEditingVar(null);
          }}
        />
      )}

      {/* 3. CREATE CUSTOM VARIABLE DIALOG */}
      {createVarOpen && (
        <CreateCustomVariableDialog
          open
          onOpenChange={setCreateVarOpen}
          effectivePeriod={activeMonthKey}
          onSuccess={async () => {
            await refreshAllAreas();
            setCreateVarOpen(false);
          }}
        />
      )}

      {/* 4. VARIABLE DETAILS DIALOG */}
      {inspectVar && (
        <VariableDetailsDialog
          open
          variable={inspectVar}
          onOpenChange={(op) => !op && setInspectVar(null)}
          onManageValues={() => {
            setManageValuesVar(inspectVar);
            setInspectVar(null);
          }}
          onEdit={() => {
            setEditingVar(inspectVar);
            setInspectVar(null);
          }}
        />
      )}

      {/* 5. MONTHLY OVERRIDES FOR CUSTOM VARIABLE */}
      {manageValuesVar && (
        <ManageMonthlyValuesDialog
          open
          variable={manageValuesVar}
          currentPeriodKey={activeMonthKey}
          onOpenChange={(op) => !op && setManageValuesVar(null)}
          onSuccess={async () => {
            await refreshAllAreas();
            setManageValuesVar(null);
          }}
        />
      )}

      {/* 6. FORMULA EXPLANATION DIALOG */}
      {explanationOpen && (
        <FormulaExplanationDialog
          open
          formulaKey={selectedFormulaKey}
          periodKey={activeMonthKey}
          onOpenChange={setExplanationOpen}
        />
      )}

      {/* 7. FORMULA HISTORY DIALOG */}
      {historyOpen && (
        <FormulaHistoryDialog
          open
          history={formulasQuery.data?.history ?? []}
          onOpenChange={setHistoryOpen}
        />
      )}
    </StaggerGroup>
  );
}

/* -------------------------------------------------------------
   FORMULA DETAILS DIALOG
------------------------------------------------------------- */

function FormulaDetailsDialog({
  open,
  formula,
  activeVersion,
  periodKey,
  estimate,
  allVars,
  onOpenChange,
  onEdit,
  onExplain,
  onHistory,
}: {
  open: boolean;
  formula: FormulaDefinitionItem;
  activeVersion: FormulaVersion | null;
  periodKey: string;
  estimate: any;
  allVars: VariableItem[];
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onExplain: () => void;
  onHistory: () => void;
}) {
  const evaluatedEquation = activeVersion?.expressionSource
    ? formatEvaluatedFormula(
        activeVersion.expressionSource,
        estimate?.variables ?? [],
        allVars,
        estimate?.resultFormatted,
        estimate?.resultMinor
      )
    : "";

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={formula.name}
      description={`Formula details & live evaluation · ${formula.outputVariableKey}`}
      wide
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2 w-full">
          <div className="flex items-center gap-1.5">
            <GlassButton
              variant="ghost"
              size="sm"
              icon={<History className="size-3.5" />}
              onClick={onHistory}
            >
              History
            </GlassButton>
            <GlassButton
              variant="secondary"
              size="sm"
              icon={<Sparkles className="size-3.5" />}
              onClick={onExplain}
            >
              Explain Trace
            </GlassButton>
          </div>
          <GlassButton
            variant="primary"
            size="sm"
            icon={<Pencil className="size-3.5" />}
            onClick={onEdit}
          >
            Edit Formula
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Header Badges & Rate */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl bg-white/[0.04] p-3.5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-foreground">{formula.name}</span>
              <StatusBadge status={formula.status} />
              {activeVersion && <Chip tone="neutral">v{activeVersion.version}</Chip>}
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              Output Key: <span className="font-semibold text-primary">{formula.outputVariableKey}</span>
            </p>
          </div>
          <div className="text-left sm:text-right">
            <span className="font-mono text-lg font-bold text-emerald-400 block">
              {estimate?.resultFormatted ?? "—"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {formula.outputVariableKey.includes("charge") ? "per meal" : "calculated rate"} ({periodKey})
            </span>
          </div>
        </div>

        {/* Human Friendly Rule */}
        {activeVersion && (
          <div className="rounded-xl bg-white/[0.03] p-3 text-xs space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Human-Friendly Rule
            </p>
            <p className="text-sm font-medium text-foreground">
              {activeVersion.humanPreview ?? activeVersion.expressionSource}
            </p>
            {activeVersion.naturalSource && (
              <p className="mt-1 text-[11px] italic text-muted-foreground">
                Prompt: &quot;{activeVersion.naturalSource}&quot;
              </p>
            )}
          </div>
        )}

        {/* Canonical Formula Syntax */}
        {activeVersion?.expressionSource && (
          <div className="flex items-center justify-between rounded-xl bg-black/20 p-2.5 sm:px-3 sm:py-2">
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto font-mono text-xs text-primary/90">
              <Code2 className="size-3.5 shrink-0 text-muted-foreground" />
              <code className="whitespace-pre sm:whitespace-normal">{activeVersion.expressionSource}</code>
            </div>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(activeVersion.expressionSource ?? "");
                toast.success("Formula copied to clipboard");
              }}
              className="ml-2 flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              <Copy className="size-3" />
              <span>Copy</span>
            </button>
          </div>
        )}

        {/* Live Evaluated Calculation */}
        {evaluatedEquation && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-semibold text-emerald-300">
              <span className="flex items-center gap-1.5">
                <Calculator className="size-3.5 text-emerald-400" />
                <span>Evaluated Calculation · {periodKey}</span>
              </span>
              <span className="font-mono text-xs font-bold text-emerald-400">
                {estimate?.resultFormatted}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <code className="overflow-x-auto font-mono text-xs font-semibold text-emerald-200">
                {evaluatedEquation}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(evaluatedEquation);
                  toast.success("Calculation copied to clipboard");
                }}
                className="ml-2 flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-200"
              >
                <Copy className="size-3" />
                <span>Copy</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   DUAL-OPTION FORMULA CREATOR / EDITOR (BOARD-OPS DETAIL-DIALOG)
------------------------------------------------------------- */

function FormulaEditorDialog({
  open,
  isNew,
  initialDefinition,
  initialVersion,
  periodKey,
  allVariables,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  isNew: boolean;
  initialDefinition: FormulaDefinitionItem | null;
  initialVersion: FormulaVersion | null;
  periodKey: string;
  allVariables: VariableItem[];
  onOpenChange: (open: boolean) => void;
  onSuccess: (outputKey: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(initialDefinition?.name ?? "");
  const [outputKey, setOutputKey] = useState(initialDefinition?.outputVariableKey ?? "");
  const [description, setDescription] = useState(initialDefinition?.description ?? "");

  // TWO PROMINENT OPTIONS: Normal (Formula Syntax) vs Natural Language (Plain Words)
  const [mode, setMode] = useState<string>(() => {
    if (initialVersion?.inputMode === "NATURAL_LANGUAGE") return "NATURAL_LANGUAGE";
    return "FORMULA";
  });

  const [formulaSource, setFormulaSource] = useState(initialVersion?.expressionSource ?? "");
  const [naturalSource, setNaturalSource] = useState(initialVersion?.naturalSource ?? "");

  const activeSource = mode === "FORMULA" ? formulaSource : naturalSource;
  const setActiveSource = mode === "FORMULA" ? setFormulaSource : setNaturalSource;

  const [reason, setReason] = useState("");
  const [effective, setEffective] = useState<string>("NEXT_PERIOD");

  const [previewResult, setPreviewResult] = useState<FormulaPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleNameChange(val: string) {
    setName(val);
    if (isNew && (!outputKey || outputKey === generateKeyFromName(name))) {
      setOutputKey(generateKeyFromName(val));
    }
  }

  function generateKeyFromName(n: string) {
    return n
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "v_$1");
  }

  function insertToken(tok: string) {
    setActiveSource((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return tok;
      return `${prev} ${tok}`;
    });
  }

  async function runPreview(customSource?: string, customMode?: string) {
    const src = (customSource ?? activeSource).trim();
    const md = (customMode ?? mode) as "FORMULA" | "NATURAL_LANGUAGE";
    if (!src) {
      toast.error("Please enter a formula expression or description first");
      return;
    }

    setPreviewLoading(true);
    setPreviewResult(null);

    try {
      const targetKey = isNew ? outputKey.trim() || "calculated_rate" : initialDefinition?.outputVariableKey;
      const res = await postJson<{ data: FormulaPreviewResult }>(PREVIEW_API, {
        mode: md,
        source: src,
        outputVariableKey: targetKey,
        period: periodKey,
      });
      setPreviewResult(res.data);
      toast.success(md === "NATURAL_LANGUAGE" ? "Description understood & validated" : "Formula syntax validated");
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSave() {
    if (isNew) {
      if (!name.trim()) return toast.error("Formula name is required");
      if (!outputKey.trim()) return toast.error("Output variable key is required");
    }
    if (!activeSource.trim()) return toast.error("Formula expression is required");

    setSaving(true);
    try {
      if (isNew) {
        await postJson(FORMULAS_API, {
          name: name.trim(),
          outputVariableKey: outputKey.trim(),
          description: description.trim() || undefined,
          scope: "BILLING_PERIOD",
          mode,
          source: activeSource.trim(),
          reason: reason.trim() || "Initial formula setup",
        });
        toast.success(`Formula '${name}' created successfully`);
        await onSuccess(outputKey.trim());
      } else {
        const outcome = await postJson<{ data: any }>(VERSIONS_API, {
          outputVariableKey: initialDefinition?.outputVariableKey,
          mode,
          source: activeSource.trim(),
          reason: reason.trim() || undefined,
          effective,
          confirmImpact: true,
        });
        toast.success("New formula version saved successfully", {
          description: outcome.data?.effectiveLabel,
        });
        await onSuccess(initialDefinition?.outputVariableKey ?? outputKey);
      }
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? "Add Formula" : `Edit ${name || "Formula"}`}
      description={
        isNew
          ? "Create a dynamic calculated operational or financial rate."
          : `Update logic for ${initialDefinition?.outputVariableKey}. Closed past billing snapshots stay frozen.`
      }
      wide
      footer={
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 w-full">
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} className="w-full sm:w-auto justify-center">
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            icon={<Save className="size-4" />}
            loading={saving}
            disabled={!previewResult || saving}
            onClick={() => void handleSave()}
            className="w-full sm:w-auto justify-center"
          >
            {isNew ? "Create Formula" : "Save Version"}
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Metadata when creating a new formula */}
        {isNew && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              label="Formula Name"
              value={name}
              onChange={handleNameChange}
              placeholder="e.g. Kitchen Operating Cost"
            />
            <TextField
              label="Output Variable Key"
              value={outputKey}
              onChange={setOutputKey}
              placeholder="e.g. total_kitchen_cost"
            />
            <div className="sm:col-span-2">
              <TextField
                label="Description (optional)"
                value={description}
                onChange={setDescription}
                placeholder="Calculates kitchen staff and operations overhead"
              />
            </div>
          </div>
        )}

        {/* TWO PROMINENT OPTIONS: Mode Switcher */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Formula Input Mode</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setMode("FORMULA");
                setPreviewResult(null);
              }}
              className={cn(
                "flex items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all text-center",
                mode === "FORMULA"
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "glass text-muted-foreground hover:text-foreground"
              )}
            >
              <Code2 className="size-3.5 shrink-0" />
              <span>Normal Mode (Formula Syntax)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("NATURAL_LANGUAGE");
                setPreviewResult(null);
              }}
              className={cn(
                "flex items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all text-center",
                mode === "NATURAL_LANGUAGE"
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "glass text-muted-foreground hover:text-foreground"
              )}
            >
              <Sparkles className="size-3.5 shrink-0" />
              <span>Natural Language (Plain Words)</span>
            </button>
          </div>
        </div>

        {/* MODE 1: NORMAL FORMULA EDITOR */}
        {mode === "FORMULA" && (
          <div className="space-y-3">
            <TextAreaField
              label="Formula Expression"
              value={formulaSource}
              onChange={setFormulaSource}
              mono
              rows={3}
              placeholder="(total_market_expense - total_guest_income) / total_resident_meals"
            />

            {/* Operator Chips */}
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Operators &amp; Functions
              </p>
              <div className="flex flex-wrap gap-1">
                {["+", "-", "*", "/", "(", ")", "ROUND( , 2)", "MAX( , 0)"].map((op) => (
                  <button
                    key={op}
                    type="button"
                    onClick={() => insertToken(op)}
                    className="glass-inset rounded-md px-2 py-0.5 font-mono text-xs font-semibold text-foreground hover:bg-foreground/10"
                  >
                    {op}
                  </button>
                ))}
              </div>
            </div>

            {/* Quick Variable Insert */}
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Click to Insert Variables
              </p>
              <div className="flex flex-wrap gap-1">
                {allVariables.slice(0, 8).map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => insertToken(v.key)}
                    className="glass-inset rounded-md px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-primary/20 hover:text-primary"
                  >
                    +{v.key}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* MODE 2: NATURAL LANGUAGE EDITOR */}
        {mode === "NATURAL_LANGUAGE" && (
          <div className="space-y-3">
            <TextAreaField
              label="Describe Calculation in Plain Words"
              value={naturalSource}
              onChange={setNaturalSource}
              rows={3}
              placeholder="Subtract guest income from total market expense and divide by resident meals"
            />

            {/* Clickable Example Prompts */}
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Try Example Prompts
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Divide market expense by resident meals",
                  "Subtract guest income from total market expense and divide by resident meals",
                  "Approved expenses divided by resident meals",
                  "Guest meals multiplied by guest meal price",
                ].map((eg) => (
                  <button
                    key={eg}
                    type="button"
                    onClick={() => {
                      setNaturalSource(eg);
                      void runPreview(eg, "NATURAL_LANGUAGE");
                    }}
                    className="glass-inset rounded-lg px-2.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-primary/20 hover:text-foreground"
                  >
                    &quot;{eg}&quot;
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Test / Understand Action Button */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2">
          <GlassButton
            variant="secondary"
            size="sm"
            icon={mode === "NATURAL_LANGUAGE" ? <Sparkles className="size-3.5" /> : <Eye className="size-3.5" />}
            loading={previewLoading}
            disabled={!activeSource.trim()}
            onClick={() => void runPreview()}
            className="w-full sm:w-auto justify-center"
          >
            {mode === "NATURAL_LANGUAGE" ? "Translate & Test Description" : "Test Formula"}
          </GlassButton>

          <span className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
            Context: <span className="font-semibold text-primary">{periodKey}</span>
          </span>
        </div>

        {/* LIVE PREVIEW BOX */}
        {previewResult && (
          <div className="glass-inset space-y-3 rounded-xl border border-primary/25 p-3.5">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                {mode === "NATURAL_LANGUAGE" ? "I Understood This As:" : "Validated Expression"}
              </p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {previewResult.humanPreview}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-primary/80">
                {previewResult.formulaText}
              </p>
            </div>

            {/* Ambiguities resolution */}
            {previewResult.ambiguities && previewResult.ambiguities.length > 0 && (
              <div className="space-y-1.5 rounded-lg bg-amber-500/10 p-2.5 text-xs">
                <p className="font-semibold text-amber-400">Clarification Needed:</p>
                {previewResult.ambiguities.map((a) => (
                  <div key={a.id} className="space-y-1">
                    <p className="text-amber-300">{a.question}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {a.options.map((opt) => (
                        <button
                          key={opt.variableKey}
                          type="button"
                          onClick={() => {
                            const updated = `${activeSource} using ${opt.label}`;
                            setActiveSource(updated);
                            void runPreview(updated, mode);
                          }}
                          className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Worked Example */}
            <div className="space-y-1 border-t border-border/40 pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-muted-foreground">Calculated Output:</span>
                <span className="font-mono font-bold text-emerald-400">
                  {previewResult.example.resultFormatted}
                </span>
              </div>

              {previewResult.example.steps.map((st, idx) => (
                <p key={idx} className="font-mono text-[11px] text-muted-foreground">
                  Step {idx + 1}: {st}
                </p>
              ))}
            </div>

            {/* Effective Schedule & Reason */}
            {!isNew && (
              <div className="border-t border-border/40 pt-2">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Apply Version From:</p>
                <FilterChips
                  chips={[
                    { value: "NEXT_PERIOD", label: "Next Billing Period (Recommended)" },
                    { value: "CURRENT_OPEN", label: "Current Open Period (Live Recalculation)" },
                  ]}
                  value={effective}
                  onChange={setEffective}
                />
              </div>
            )}

            <TextField
              label="Change Reason (optional)"
              value={reason}
              onChange={setReason}
              placeholder="e.g. Updated formula to include cook staff salary"
            />
          </div>
        )}
      </div>
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   DIRECT VARIABLE VALUE EDITOR (GUEST PRICE, DEFICIT, CUSTOMS)
------------------------------------------------------------- */

function EditVariableValueDialog({
  open,
  variable,
  currentPeriodKey,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  variable: VariableItem;
  currentPeriodKey: string;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}) {
  const isMoney = variable.valueType === "MONEY" || variable.unit === "INR";
  const isCustom = variable.category === "CUSTOM";

  const [value, setValue] = useState(() => {
    if (isMoney) return (variable.valueRaw / 100).toString();
    return variable.valueRaw.toString();
  });
  const [periodKey, setPeriodKey] = useState(currentPeriodKey);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!value.trim()) return toast.error("Please enter a valid value");
    const num = parseFloat(value);
    if (isNaN(num)) return toast.error("Please enter a numeric value");
    if (num < 0) return toast.error("Value cannot be negative");

    setSaving(true);
    try {
      await postJson(VARIABLES_API, {
        key: variable.key,
        value: num,
        period: isCustom ? periodKey : undefined,
      });
      toast.success(`Updated ${variable.displayName} successfully`);
      await onSuccess();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${variable.displayName}`}
      description={isCustom ? `Custom parameter · ${variable.key}` : `System parameter · ${variable.key}`}
      footer={
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 w-full">
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} className="w-full sm:w-auto justify-center">
            Cancel
          </GlassButton>
          <GlassButton variant="primary" icon={<Save className="size-4" />} onClick={handleSave} loading={saving} className="w-full sm:w-auto justify-center">
            Save Changes
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-3.5">
        <div className="glass-inset rounded-lg p-3 text-xs">
          <p className="text-muted-foreground">{variable.description}</p>
          <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2 font-mono text-[11px]">
            <span className="text-muted-foreground">Current Value:</span>
            <span className="font-semibold text-emerald-400">{variable.valueFormatted}</span>
          </div>
        </div>

        {isCustom && (
          <TextField
            label="Billing Period Context (YYYY-MM)"
            value={periodKey}
            onChange={setPeriodKey}
            placeholder="2026-09"
          />
        )}

        <TextField
          label={`New Value ${isMoney ? "(in ₹ Rupees)" : `(${variable.unit})`}`}
          value={value}
          onChange={setValue}
          placeholder={isMoney ? "65.00" : "0"}
          type="number"
          autoFocus
        />

        <p className="text-[11px] text-muted-foreground">
          Saving updates this parameter in BoardOps and automatically recalculates all formulas depending on &apos;{variable.key}&apos;.
        </p>
      </div>
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   CREATE CUSTOM VARIABLE DIALOG
------------------------------------------------------------- */

function CreateCustomVariableDialog({
  open,
  onOpenChange,
  effectivePeriod,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  effectivePeriod: string;
  onSuccess: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState<string>("MONEY");
  const [unit, setUnit] = useState("INR");
  const [initialValue, setInitialValue] = useState("12000");
  const [loading, setLoading] = useState(false);

  function handleNameChange(val: string) {
    setName(val);
    if (!key || key === generateKeyFromName(name)) {
      setKey(generateKeyFromName(val));
    }
  }

  function generateKeyFromName(n: string) {
    return n
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "v_$1");
  }

  async function handleSubmit() {
    if (!name.trim()) return toast.error("Variable name is required");
    const num = parseFloat(initialValue);
    if (isNaN(num)) return toast.error("Initial value must be a valid number");

    setLoading(true);
    try {
      await postJson(CUSTOM_VARS_API, {
        name: name.trim(),
        key: key.trim() || undefined,
        description: description.trim() || undefined,
        valueType,
        unit,
        scope: "BILLING_PERIOD",
        frequency: "MONTHLY",
        initialValue: valueType === "MONEY" ? Math.round(num * 100) : num,
        effectivePeriod,
      });
      toast.success(`Created custom variable '${name}'`);
      await onSuccess();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add Custom Variable"
      description="Create a manual parameter usable across billing and operational formulas."
      footer={
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 w-full">
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} className="w-full sm:w-auto justify-center">
            Cancel
          </GlassButton>
          <GlassButton variant="primary" loading={loading} onClick={() => void handleSubmit()} className="w-full sm:w-auto justify-center">
            Create Variable
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-3">
        <TextField label="Variable Name" value={name} onChange={handleNameChange} placeholder="Kitchen Staff Salary" />
        <TextField label="Machine Key" value={key} onChange={setKey} placeholder="kitchen_staff_salary" />
        <TextField label="Description" value={description} onChange={setDescription} placeholder="Monthly kitchen salary" />

        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Type"
            value={valueType}
            onChange={(v) => {
              setValueType(v);
              if (v === "MONEY") setUnit("INR");
              else if (v === "PERCENTAGE") setUnit("PERCENT");
            }}
            options={[
              { value: "MONEY", label: "Money (₹)" },
              { value: "NUMBER", label: "Number" },
              { value: "PERCENTAGE", label: "Percentage (%)" },
              { value: "COUNT", label: "Count" },
            ]}
          />
          <TextField label="Unit" value={unit} onChange={setUnit} placeholder="INR / meals / %" />
        </div>

        <TextField
          label={`Initial Value (${valueType === "MONEY" ? "₹ Rupees" : unit})`}
          value={initialValue}
          onChange={setInitialValue}
          placeholder="12000"
        />
      </div>
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   VARIABLE DETAILS DIALOG
------------------------------------------------------------- */

function VariableDetailsDialog({
  open,
  variable,
  onOpenChange,
  onManageValues,
  onEdit,
}: {
  open: boolean;
  variable: VariableItem;
  onOpenChange: (open: boolean) => void;
  onManageValues: () => void;
  onEdit?: () => void;
}) {
  const isCustom = variable.category === "CUSTOM";
  const invalidate = useInvalidate();

  async function archive() {
    if (!variable.id) return;
    if (!confirm(`Are you sure you want to archive '${variable.displayName}'?`)) return;
    try {
      await postJson(`${CUSTOM_VARS_API}/${variable.id}/archive`, {});
      toast.success("Variable archived successfully");
      invalidate([
        VARIABLES_API,
        FORMULAS_API,
        "/api/v1/admin/formulas",
        "/api/v1/admin/formulas/variables",
      ]);
      onOpenChange(false);
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={variable.displayName}
      description={`Variable Metadata · ${variable.key}`}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 w-full">
          {isCustom && (
            <>
              <GlassButton variant="ghost" size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => void archive()} className="flex-1 sm:flex-none justify-center">
                Archive
              </GlassButton>
              <GlassButton variant="secondary" size="sm" icon={<Calendar className="size-3.5" />} onClick={onManageValues} className="flex-1 sm:flex-none justify-center">
                Monthly Overrides
              </GlassButton>
            </>
          )}
          {variable.isEditable && onEdit && (
            <GlassButton variant="primary" size="sm" icon={<Pencil className="size-3.5" />} onClick={onEdit} className="w-full sm:w-auto justify-center">
              Edit Value
            </GlassButton>
          )}
        </div>
      }
    >
      <div className="space-y-3.5">
        <div className="glass-inset rounded-lg p-3 text-xs">
          <p className="text-muted-foreground">{variable.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <KeyValue label="Category" value={<Chip tone="frost">{variable.category}</Chip>} />
          <KeyValue label="Value Type" value={<span className="font-mono">{variable.valueType}</span>} />
          <KeyValue label="Unit" value={<span className="font-mono">{variable.unit}</span>} />
          <KeyValue label="Scope" value={<span className="font-mono">{variable.scope}</span>} />
          <KeyValue label="Current Value" value={<span className="font-mono font-bold text-emerald-400">{variable.valueFormatted}</span>} />
          <KeyValue label="Provider" value={<span className="font-mono">{variable.providerKey ?? "MANUAL"}</span>} />
        </div>

        {variable.usedByFormulas && variable.usedByFormulas.length > 0 ? (
          <div className="rounded-lg bg-primary/10 p-2.5 text-xs">
            <p className="font-semibold text-primary">Used by Formulas:</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {variable.usedByFormulas.map((f) => (
                <Chip key={f} tone="frost">
                  {f}
                </Chip>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">Not referenced in any active formulas yet.</p>
        )}
      </div>
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   MANAGE MONTHLY VALUES FOR CUSTOM VARIABLE
------------------------------------------------------------- */

function ManageMonthlyValuesDialog({
  open,
  variable,
  currentPeriodKey,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  variable: VariableItem;
  currentPeriodKey: string;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}) {
  const [periodKey, setPeriodKey] = useState(currentPeriodKey);
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSet() {
    if (!newValue.trim()) return toast.error("Enter a value");
    const num = parseFloat(newValue);
    if (isNaN(num)) return toast.error("Invalid number");

    setSaving(true);
    try {
      await postJson(`${CUSTOM_VARS_API}/${variable.id}/values`, {
        billingPeriodKey: periodKey,
        value: variable.valueType === "MONEY" ? Math.round(num * 100) : num,
      });
      toast.success(`Value set for ${periodKey}`);
      await onSuccess();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Monthly Values · ${variable.displayName}`}
      description="Configure period-specific overrides without modifying historical closed bills."
      footer={
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 w-full">
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} className="w-full sm:w-auto justify-center">
            Close
          </GlassButton>
          <GlassButton variant="primary" loading={saving} onClick={() => void handleSet()} className="w-full sm:w-auto justify-center">
            Set Value
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Billing Period (YYYY-MM)"
            value={periodKey}
            onChange={setPeriodKey}
            placeholder="2026-09"
          />
          <TextField
            label={`Value (${variable.unit})`}
            value={newValue}
            onChange={setNewValue}
            placeholder="13000"
          />
        </div>
      </div>
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   FORMULA EXPLANATION DIALOG
------------------------------------------------------------- */

function FormulaExplanationDialog({
  open,
  formulaKey,
  periodKey,
  onOpenChange,
}: {
  open: boolean;
  formulaKey: string;
  periodKey: string;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useApiQuery<{ data: any }>(
    `/api/v1/admin/formulas/explain?outputVariable=${formulaKey}&period=${periodKey}`
  );

  const expl = query.data?.data?.explanation as FormulaExplanationData | undefined;

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Calculation Trace"
      description={`Step-by-step arithmetic trace for ${formulaKey} (${periodKey})`}
      wide
      footer={
        <div className="flex justify-end w-full">
          <GlassButton variant="primary" onClick={() => onOpenChange(false)} className="w-full sm:w-auto justify-center">
            Done
          </GlassButton>
        </div>
      }
    >
      {query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : expl ? (
        <div className="space-y-3">
          <div className="glass-inset rounded-lg p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Friendly Formula</p>
            <p className="mt-0.5 text-sm font-medium">{query.data?.data?.friendlyExpression}</p>
          </div>

          <div className="space-y-1.5">
            {expl.steps.map((st) => (
              <div key={st.stepNumber} className="glass-inset flex flex-col sm:flex-row sm:items-center justify-between gap-1 rounded-lg p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/20 font-mono text-[10px] font-bold text-primary">
                    {st.stepNumber}
                  </span>
                  <span className="leading-snug">{st.description}</span>
                </div>
                {st.resultFormatted && (
                  <span className="font-mono font-semibold text-foreground shrink-0 pl-7 sm:pl-0">{st.resultFormatted}</span>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-primary/10 p-3">
            <span className="text-xs font-semibold text-primary">Final Calculated Rate</span>
            <span className="font-mono text-base font-bold text-emerald-400">{expl.finalResultFormatted}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Explanation not available for this period.</p>
      )}
    </DetailDialog>
  );
}

/* -------------------------------------------------------------
   FORMULA HISTORY DIALOG
------------------------------------------------------------- */

function FormulaHistoryDialog({
  open,
  history,
  onOpenChange,
}: {
  open: boolean;
  history: FormulaVersion[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Formula History"
      description="Immutable historical formula versions."
      wide
      footer={
        <div className="flex justify-end w-full">
          <GlassButton variant="primary" onClick={() => onOpenChange(false)} className="w-full sm:w-auto justify-center">
            Close
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">No prior versions recorded.</p>
        ) : (
          history.map((ver) => (
            <div key={ver.id} className="glass-inset rounded-xl p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-primary">v{ver.version}</span>
                  {ver.active && <StatusBadge status="ACTIVE" />}
                  <span className="text-muted-foreground">
                    {ver.effectiveFrom ? `Effective ${ver.effectiveFrom.slice(0, 10)}` : "Historical"}
                  </span>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">{ver.checksum.slice(0, 8)}</span>
              </div>
              <p className="mt-1 font-medium text-foreground">{ver.humanPreview ?? ver.expressionSource}</p>
              {ver.reason && <p className="mt-0.5 text-muted-foreground">Reason: {ver.reason}</p>}
            </div>
          ))
        )}
      </div>
    </DetailDialog>
  );
}
