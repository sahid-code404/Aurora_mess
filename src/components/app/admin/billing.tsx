"use client";

/**
 * Admin Billing — periods with readiness gates, arithmetic confirmation,
 * generation results, snapshot views, reopen (48h) and bill adjustments.
 * BoardOps composition, meals-page anatomy: KPIs → ONE section card
 * (icon + title + count header, view pills INSIDE) holding period rows or
 * resident bill rows; readiness/snapshot panels stay standalone cards.
 * GET /admin/billing/periods · GET .../readiness · POST .../generate ·
 * POST .../reopen · GET /admin/bills · POST /admin/bills/:id/adjustment
 */

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Banknote,
  Calendar,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  Coins,
  CreditCard,
  FileSpreadsheet,
  Lock,
  LockOpen,
  Receipt,
  ReceiptText,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  Utensils,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import SectionHeading from "@/components/glass/SectionHeading";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { navigateTo } from "@/hooks/use-hash-route";
import { ApiClientError } from "@/lib/api";
import { initialsOf } from "@/lib/gradients";
import { SPRING_SNAPPY } from "@/lib/motion";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useApiMetaQuery, errMessage, useInvalidate, metaNum, metaStr } from "./_shared/api";
import { currentMonthKeyInTz } from "./_shared/business-date";
import { MoneyField, SearchField, TextAreaField } from "./_shared/fields";
import { FilterChips, KpiGrid, KeyValue } from "./_shared/chrome";
import { fmtDate, fmtDateTime, monthLabel } from "./_shared/format";
import type { BillingPeriodRow, BillRow } from "./_shared/types";

const PERIODS_PATH = "/api/v1/admin/billing/periods";
const BILLS_PATH = "/api/v1/admin/bills";

/** "2025-09" ± 1 → "2025-08" / "2025-10". */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2025, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Long month name for the picker pill ("September"). */
function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2025, (m ?? 1) - 1, 1));
}

/* ------------------------------------------------------------------ view */

export default function AdminBilling() {
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  const thisMonthKey = currentMonthKeyInTz(tz);
  const activeMonthKey = monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;

  const { data: periodsEnvelope, isLoading: periodsLoading, error: periodsError, refetch: periodsRefetch } =
    useApiMetaQuery<BillingPeriodRow[]>(PERIODS_PATH);
  const periods = periodsEnvelope?.data ?? [];

  const activeYear = Number(activeMonthKey.slice(0, 4));
  const activeMonth = Number(activeMonthKey.slice(5, 7));
  const activePeriod = periods.find((p) => p.year === activeYear && p.month === activeMonth) ?? null;

  const billsEnvelopeQuery = useApiMetaQuery<BillRow[]>(BILLS_PATH, {
    month: activeMonthKey,
    periodId: activePeriod?.id,
  });
  const billsMeta = billsEnvelopeQuery.data?.meta ?? {};

  if (periodsError) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={(periodsError as ApiClientError | undefined)?.code}
          message={(periodsError as ApiClientError | undefined)?.message}
          onRetry={() => void periodsRefetch()}
        />
      </div>
    );
  }

  return (
    <StaggerGroup className="space-y-4">
      <StaggerItem>
        <PickerCapsule
          onPrev={() => setMonthParam(shiftMonthKey(activeMonthKey, -1))}
          onNext={() => setMonthParam(shiftMonthKey(activeMonthKey, 1))}
          prevLabel="Previous month"
          nextLabel="Next month"
          onPillClick={() => setMonthParam(undefined)}
          pillAriaLabel="Reset to the current month"
          resettable={!isThisMonth}
        >
          <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 text-center leading-tight">
            <span className="block truncate text-sm font-bold text-primary">{monthLongName(activeMonthKey)}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{activeMonthKey.slice(0, 4)}</span>
          </span>
        </PickerCapsule>
      </StaggerItem>

      <StaggerItem>
        <KpiGrid
          loading={billsEnvelopeQuery.isLoading}
          kpis={[
            { label: "Billed", value: metaStr(billsMeta, "totalBilledFormatted") ?? "₹0.00", icon: <FileSpreadsheet />, tone: "primary", glow: "primary", sub: "Generated" },
            { label: "Collected", value: metaStr(billsMeta, "totalCollectedFormatted") ?? "₹0.00", icon: <Banknote />, tone: "success", glow: "success", sub: "Received" },
            { label: "Overdue", value: String(metaNum(billsMeta, "overdueCount") ?? 0), icon: <TriangleAlert />, tone: "danger", glow: "danger", sub: "Past due" },
          ]}
        />
      </StaggerItem>

      {periodsLoading ? (
        <StaggerItem><GlassCard className="p-4"><ListSkeleton rows={4} /></GlassCard></StaggerItem>
      ) : activePeriod ? (
        activePeriod.status === "BILLED" || activePeriod.status === "REOPENED" ? (
          <StaggerItem><BilledPanel period={activePeriod} /></StaggerItem>
        ) : (
          <StaggerItem><ReadinessPanel period={activePeriod} /></StaggerItem>
        )
      ) : (
        <StaggerItem>
          <EmptyState icon={CalendarRange} title={`No billing period for ${monthLongName(activeMonthKey)} ${activeMonthKey.slice(0, 4)}`} description="Billing periods open automatically when the mess starts operations." />
        </StaggerItem>
      )}
    </StaggerGroup>
  );
}

interface ReadinessData {
  period: { id: string; year: number; month: number; monthLabel: string; status: string; billedAt: string | null };
  checks: { key: string; label: string; pass: boolean; detail?: string }[];
  ready: boolean;
  summary: {
    residentCount: number; residentMealCount: number; guestMealCount: number; guestIncomeFormatted?: string;
    eligibleExpensesMinor: number; eligibleExpensesFormatted: string; approvedPaymentsMinor: number;
    approvedPaymentsFormatted: string; guestPriceMinor: number; guestPriceFormatted: string;
    mealChargeFormatted: string; formulaVersion?: { version: number; expressionSource: string; humanPreview: string } | null;
  };
  arithmeticChallenge: { a: number; b: number };
}

interface GenerateResult {
  billCount: number; mealChargeMinor: number; mealChargeFormatted: string; totalBilledMinor: number;
  totalBilledFormatted: string; totalDueMinor: number; totalDueFormatted: string;
  totalPaymentsAppliedMinor: number; totalPaymentsAppliedFormatted: string;
}

function PeriodMetricsGrid({ mealChargeFormatted, mealChargeBroken, residentMealCount, residentCount, guestMealCount, guestIncomeFormatted, eligibleExpensesFormatted, approvedPaymentsFormatted, formulaVersion }: {
  mealChargeFormatted: string; mealChargeBroken?: boolean; residentMealCount: number; residentCount: number;
  guestMealCount: number; guestIncomeFormatted?: string; eligibleExpensesFormatted: string;
  approvedPaymentsFormatted: string; formulaVersion?: number | string | null;
}) {
  const metrics = [
    ["Meal Charge", mealChargeBroken ? "—" : mealChargeFormatted, "/ meal", "text-emerald-400"],
    ["Resident Meals", String(residentMealCount), "meals", "text-foreground"],
    ["Residents", String(residentCount), "", "text-foreground"],
    ["Guest Meals", String(guestMealCount), "meals", "text-foreground"],
    ["Guest Income", guestIncomeFormatted ?? "₹0.00", "", "text-emerald-400"],
    ["Expenses", eligibleExpensesFormatted, "", "text-foreground"],
    ["Payments", approvedPaymentsFormatted, "", "text-emerald-400"],
    ["Formula", formulaVersion != null ? `v${formulaVersion}` : "—", "", "text-foreground"],
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
      {metrics.map(([label, value, suffix, tone], index) => (
        <div key={label} className={cn("glass-inset flex flex-col justify-between rounded-2xl p-3 sm:p-3.5 border", index === 0 ? "border-primary/25 bg-primary/5" : "border-border/20")}>
          <span className={cn("text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider truncate", index === 0 ? "text-emerald-400" : "text-muted-foreground")}>{label}</span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className={cn("kpi-num font-bold truncate", index === 0 ? "text-lg sm:text-xl md:text-2xl font-extrabold" : "text-base sm:text-lg md:text-xl", tone)}>{value}</span>
            {suffix && <span className="text-[11px] sm:text-xs text-muted-foreground shrink-0">{suffix}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReadinessPanel({ period }: { period: BillingPeriodRow }) {
  const readinessPath = `${PERIODS_PATH}/${period.id}/readiness`;
  const { data, isLoading, error, refetch } = useApiQuery<ReadinessData>(readinessPath);
  const [answer, setAnswer] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const invalidate = useInvalidate();

  if (isLoading && !data) return <GlassCard className="p-4 sm:p-5 space-y-3"><ListSkeleton rows={4} /></GlassCard>;
  if (error || !data) return <GlassCard className="p-4 sm:p-5"><SectionHeading>Readiness · {period.monthLabel}</SectionHeading><div className="mt-3"><ErrorState code={(error as ApiClientError | undefined)?.code} message={(error as ApiClientError | undefined)?.message} onRetry={() => void refetch()} /></div></GlassCard>;

  const mealChargeBroken = /NaN/i.test(data.summary.mealChargeFormatted ?? "");
  const challengeOk = Number(answer) === data.arithmeticChallenge.a + data.arithmeticChallenge.b;
  const canGenerate = data.ready && challengeOk && !mealChargeBroken;

  async function generate() {
    setGenerating(true);
    try {
      const res = await postJson<GenerateResult>(`${PERIODS_PATH}/${period.id}/generate`, { a: data!.arithmeticChallenge.a, b: data!.arithmeticChallenge.b, answer: Number(answer) });
      setResult(res);
      invalidate([PERIODS_PATH, BILLS_PATH, "/api/v1/admin/dashboard", "/api/v1/admin/funds"]);
      toast.success("Bills generated", { description: `${period.monthLabel} · ${res.billCount} bills · ${res.totalBilledFormatted}` });
    } catch (err) { toast.error(errMessage(err)); } finally { setGenerating(false); }
  }

  if (result) return (
    <GlassCard className="space-y-4 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><CheckCircle2 className="size-5 text-emerald-400" /><h3 className="text-sm font-semibold text-foreground">Bills generated · {period.monthLabel}</h3></div><GlassButton variant="secondary" size="sm" onClick={() => setResult(null)}>View bills</GlassButton></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-xl bg-foreground/2 dark:bg-white/[0.03] border border-border/20 p-2.5 text-center">
        {[['Bills', String(result.billCount), 'text-foreground'], ['Meal Charge', result.mealChargeFormatted, 'text-foreground'], ['Total Billed', result.totalBilledFormatted, 'text-foreground'], ['Total Due', result.totalDueFormatted, 'text-warning']].map(([label, value, tone]) => <div key={label}><p className="text-[10px] uppercase font-semibold text-muted-foreground">{label}</p><p className={cn("kpi-num text-sm font-bold mt-0.5", tone)}>{value}</p></div>)}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">Snapshot frozen with checksum. Closed-period corrections happen via tracked bill adjustments.</p>
    </GlassCard>
  );

  function getCheckSentence(check: { key: string; label: string; pass: boolean; detail?: string }): { title: string; sentence: string } {
    switch (check.key) {
      case "month_ended": return { title: "Billing month cycle", sentence: check.pass ? "Billing month concluded · Ready for closure" : (check.detail ?? "Billing month is still active") };
      case "period_open": return { title: "Period status", sentence: check.pass ? "Open & accepting operational entries" : (check.detail ?? "Period is closed or billed") };
      case "pending_payments": return { title: "Payment reviews", sentence: check.pass ? "All member payments reviewed & approved" : check.label };
      case "formula_version": return { title: "Meal charge formula", sentence: check.pass ? "Active formula configured and locked" : "No active formula covering period" };
      case "meal_charge_computable": return { title: "Meal rate calculation", sentence: check.pass ? "Valid rate computed from expenses & meals" : (check.detail ?? "Cannot compute meal rate") };
      case "ledger_reconciled": return { title: "Ledger reconciliation", sentence: check.pass ? "All journal entries balanced with approved records" : (check.detail ?? "Unreconciled records") };
      case "no_duplicate_resident_meals": return { title: "Resident meal logs", sentence: check.pass ? "No duplicate meal entries detected" : (check.detail ?? "Duplicate logs found") };
      case "no_duplicate_meal_instances": return { title: "Service schedule", sentence: check.pass ? "Unique meal instances per scheduled date" : (check.detail ?? "Duplicate instances found") };
      case "guest_totals_reconcile": return { title: "Guest meal pricing", sentence: check.pass ? "Guest meal prices match billing totals" : (check.detail ?? "Guest pricing mismatch") };
      case "pending_expenses": return { title: "Expense approvals", sentence: check.pass ? "All submitted expenses reviewed & posted" : check.label };
      case "submitted_tasks": return { title: "Task submissions", sentence: check.pass ? "No pending resident task reviews" : check.label };
      default: return { title: check.label, sentence: check.detail ?? (check.pass ? "Verified and passed" : "Needs attention") };
    }
  }

  return (
    <div className="space-y-4">
      <GlassCard className="space-y-3.5 p-3.5 sm:p-4">
        <div className="flex items-center gap-2.5 min-w-0"><span className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"><ReceiptText className="size-4.5 sm:size-5" /></span><h3 className="font-semibold text-sm sm:text-base text-foreground tracking-tight truncate">Billing Details · {period.monthLabel}</h3></div>
        <PeriodMetricsGrid mealChargeFormatted={data.summary.mealChargeFormatted} mealChargeBroken={mealChargeBroken} residentMealCount={data.summary.residentMealCount} residentCount={data.summary.residentCount} guestMealCount={data.summary.guestMealCount} guestIncomeFormatted={data.summary.guestIncomeFormatted} eligibleExpensesFormatted={data.summary.eligibleExpensesFormatted} approvedPaymentsFormatted={data.summary.approvedPaymentsFormatted} formulaVersion={data.summary.formulaVersion?.version} />
      </GlassCard>
      <GlassCard className="p-3.5 sm:p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2.5"><div className="flex items-center gap-2 min-w-0"><span className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"><ShieldCheck className="size-4.5 sm:size-5" /></span><div className="min-w-0"><h3 className="font-semibold text-sm sm:text-base text-foreground tracking-tight truncate">Readiness · {period.monthLabel}</h3><p className="text-[11px] sm:text-xs text-muted-foreground truncate">Audit verification before period closure</p></div></div><span className="text-[10px] sm:text-[11px] font-medium text-muted-foreground bg-foreground/5 dark:bg-white/5 border border-border/20 px-2 py-0.5 rounded-full shrink-0">{data.checks.length} criteria</span></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{data.checks.map((check) => { const info = getCheckSentence(check); const ongoing = check.key === "month_ended" && !check.pass; return <div key={check.key} className="flex items-start gap-2.5 rounded-xl px-3 py-2 text-xs bg-foreground/2 dark:bg-white/[0.025] border border-border/15 transition-colors hover:border-border/30"><span className="mt-0.5 shrink-0">{check.pass ? <CheckCircle2 className="size-3.5 text-emerald-400" /> : ongoing ? <CalendarClock className="size-3.5 text-primary" /> : <XCircle className="size-3.5 text-warning" />}</span><div className="min-w-0 flex-1"><p className="font-semibold text-foreground truncate">{info.title}</p><p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{info.sentence}</p></div></div>; })}</div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t border-border/20 pt-3">
          {!data.ready ? <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0"><Lock className="size-3.5 shrink-0" /><span className="truncate">{data.checks.find((c) => !c.pass)?.detail ?? "Complete all readiness criteria above to generate bills."}</span></div> : <div className="flex items-center gap-2 text-xs"><span className="text-muted-foreground font-medium">Security challenge:</span><span className="font-mono font-bold text-foreground">{data.arithmeticChallenge.a} + {data.arithmeticChallenge.b} =</span><input type="number" inputMode="numeric" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="?" aria-label="Challenge answer" className="glass h-7 w-12 rounded text-center text-xs font-bold font-mono outline-none ring-1 ring-border/50 focus:ring-primary" /></div>}
          <GlassButton variant="primary" size="sm" disabled={!canGenerate} loading={generating} onClick={() => void generate()} className="w-full sm:w-auto shrink-0">Generate bills</GlassButton>
        </div>
      </GlassCard>
    </div>
  );
}

interface PeriodDetailData {
  period: BillingPeriodRow & { billedAt: string | null; closedAt: string | null; formulaVersionId: string | null };
  snapshot: { id: string; checksum: string; createdAt: string; residentCount: number; residentMealCount: number; guestMealCount: number; guestIncomeFormatted?: string; eligibleExpensesFormatted: string; approvedPaymentsFormatted: string; mealChargeMinor: number; mealChargeFormatted: string; formula: { version: number; expression: string; mealChargeMinor: number } | null } | null;
  bills: (BillRow & { residentName: string })[];
}

function BilledPanel({ period }: { period: BillingPeriodRow }) {
  const { data, isLoading, error, refetch } = useApiQuery<PeriodDetailData>(`${PERIODS_PATH}/${period.id}`);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [selectedBill, setSelectedBill] = useState<BillRow | null>(null);
  const [adjusting, setAdjusting] = useState<BillRow | null>(null);
  const [acting, setActing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("DUE");
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const reopenWindowOpen = useMemo(() => !!period.billedAt && Date.now() - new Date(period.billedAt).getTime() < 48 * 3600 * 1000, [period.billedAt]);

  async function reopen(reason: string | undefined) { setActing(true); try { await postJson(`${PERIODS_PATH}/${period.id}/reopen`, { reason }); invalidate([PERIODS_PATH, BILLS_PATH]); toast.success("Period reopened", { description: "Bills remain authoritative — corrections happen via adjustments." }); setReopenOpen(false); } catch (err) { toast.error(errMessage(err)); } finally { setActing(false); } }

  const sortedBills = useMemo(() => [...(data?.bills ?? [])].sort((a, b) => { const aDue = a.totalDueMinor > 0; const bDue = b.totalDueMinor > 0; if (aDue && !bDue) return -1; if (!aDue && bDue) return 1; if (aDue && bDue) return b.totalDueMinor - a.totalDueMinor; return a.billNumber.localeCompare(b.billNumber); }), [data?.bills]);
  const dueCount = useMemo(() => sortedBills.filter((b) => b.totalDueMinor > 0).length, [sortedBills]);
  const paidCount = useMemo(() => sortedBills.filter((b) => b.status === "PAID").length, [sortedBills]);
  const overdueCount = useMemo(() => sortedBills.filter((b) => b.status === "OVERDUE").length, [sortedBills]);
  const chips = useMemo(() => [{ value: "DUE", label: "Due", count: dueCount }, { value: "ALL", label: "All", count: sortedBills.length }, { value: "PAID", label: "Paid", count: paidCount }, ...(overdueCount > 0 ? [{ value: "OVERDUE", label: "Overdue", count: overdueCount }] : [])], [sortedBills.length, dueCount, paidCount, overdueCount]);
  const filteredBills = useMemo(() => { let list = sortedBills; if (search.trim()) { const q = search.trim().toLowerCase(); list = list.filter((b) => b.residentName.toLowerCase().includes(q) || b.billNumber.toLowerCase().includes(q)); } if (statusFilter !== "ALL") list = statusFilter === "DUE" ? list.filter((b) => b.totalDueMinor > 0) : list.filter((b) => b.status === statusFilter); return list; }, [sortedBills, search, statusFilter]);

  if (isLoading && !data) return <div className="space-y-4"><GlassCard className="space-y-4 p-4"><SectionHeading>Bill details · {period.monthLabel}</SectionHeading><ListSkeleton rows={3} /></GlassCard><GlassCard className="p-4"><ListSkeleton rows={4} /></GlassCard></div>;
  if (error || !data) return <GlassCard className="p-4"><SectionHeading>Bill details · {period.monthLabel}</SectionHeading><div className="mt-3"><ErrorState code={(error as ApiClientError | undefined)?.code} message={(error as ApiClientError | undefined)?.message} onRetry={() => void refetch()} /></div></GlassCard>;

  return (
    <div className="space-y-4">
      <GlassCard className="space-y-3.5 p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-2.5 flex-wrap"><div className="flex items-center gap-2.5 min-w-0"><span className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"><ReceiptText className="size-4.5 sm:size-5" /></span><h3 className="font-semibold text-sm sm:text-base text-foreground tracking-tight truncate">Bill Details · {period.monthLabel}</h3></div><div className="flex items-center gap-2">{reopenWindowOpen ? <GlassButton variant="destructive" size="sm" icon={<RotateCcw />} onClick={() => setReopenOpen(true)}>Reopen…</GlassButton> : <span className="text-[10px] sm:text-[11px] font-medium text-muted-foreground bg-foreground/5 dark:bg-white/5 border border-border/20 px-2.5 py-1 rounded-full shrink-0">Reopen window closed</span>}</div></div>
        {data.snapshot && <PeriodMetricsGrid mealChargeFormatted={data.snapshot.mealChargeFormatted} residentMealCount={data.snapshot.residentMealCount} residentCount={data.snapshot.residentCount} guestMealCount={data.snapshot.guestMealCount} guestIncomeFormatted={data.snapshot.guestIncomeFormatted} eligibleExpensesFormatted={data.snapshot.eligibleExpensesFormatted} approvedPaymentsFormatted={data.snapshot.approvedPaymentsFormatted} formulaVersion={data.snapshot.formula?.version} />}
      </GlassCard>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"><Users className="size-5" aria-hidden /></span><h3 className="font-semibold text-base">Resident Bills</h3><span className="ml-auto text-xs text-muted-foreground hidden sm:inline">Corrections happen via adjustments</span></div>
        <div className="mb-3 space-y-3"><SearchField value={search} onChange={setSearch} placeholder="Search by resident name or bill number…" /><FilterChips chips={chips} value={statusFilter} onChange={setStatusFilter} layoutId="admin-billed-chips" /></div>
        {filteredBills.length === 0 ? <EmptyState icon={Users} title={search || statusFilter !== "ALL" ? "No bills match" : "No bills yet"} description={search || statusFilter !== "ALL" ? "Try a different search query or status filter." : "Bills will appear here once generated."} /> : <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">{filteredBills.map((b, i) => <motion.div key={b.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(i * 0.03, 0.2) }}><GlassCard className="overflow-hidden rounded-2xl"><div role="button" tabIndex={0} onClick={() => setSelectedBill(b as unknown as BillRow)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedBill(b as unknown as BillRow); } }} className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2.5 min-w-0"><span aria-hidden className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-primary">{initialsOf(b.residentName)}</span><div className="min-w-0"><div className="flex items-center gap-1.5"><h4 className="truncate text-sm font-semibold text-foreground tracking-tight">{b.residentName}</h4><StatusBadge status={b.status} /></div><p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate font-mono"><ArrowUpRight className="size-3 shrink-0" aria-hidden />{b.billNumber}<span className="font-sans text-muted-foreground/70 ml-1">· {b.residentMealCount} meals{b.guestMealCount > 0 ? ` + ${b.guestMealCount} guest` : ""}</span></p></div></div><div className="text-right shrink-0"><Money minor={b.totalDueMinor} className={cn("text-base font-bold block leading-tight", b.totalDueMinor > 0 ? "text-warning" : "text-success")} /><span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">{b.totalDueMinor > 0 ? "due" : "settled"}</span></div></div><div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/15 pt-2"><div className="no-scrollbar flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground"><span className="shrink-0">Subtotal <Money minor={b.subtotalMinor} plain className="font-semibold text-foreground" /></span><span className="shrink-0">· Paid <Money minor={b.paymentsMinor} plain className="font-semibold text-success" /></span>{b.adjustmentsMinor !== 0 && <span className="shrink-0">· Adj <Money minor={b.adjustmentsMinor} withSign plain className="font-semibold" /></span>}</div><motion.button type="button" whileTap={{ scale: 0.94 }} onClick={(e) => { e.stopPropagation(); setSelectedBill(b as unknown as BillRow); }} aria-label={`View details for ${b.residentName}`} className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><span>Details</span><ArrowRight className="size-3.5" aria-hidden /></motion.button></div></div></GlassCard></motion.div>)}</div>}
        <p className="kpi-num mt-2 text-[11px] text-muted-foreground/75">Generated {data.period.billedAt ? fmtDateTime(data.period.billedAt, tz) : "—"}</p>
      </GlassCard>
      {reopenOpen && <ConfirmDialog open onOpenChange={(open) => !open && setReopenOpen(false)} title={`Reopen ${period.monthLabel}`} description="Reopening marks the period as reopened for review — generated bills remain authoritative and corrections go through bill adjustments. This is allowed only within 48 hours of generation." confirmLabel="Reopen period" tone="destructive" requireReason reasonPlaceholder="Why is this period being reopened? (required)" loading={acting} onConfirm={(reason) => void reopen(reason)} />}
      {selectedBill && <BillDetailsDialog bill={selectedBill} tz={tz} onClose={() => setSelectedBill(null)} onAdjust={() => { const billToAdjust = selectedBill; setSelectedBill(null); setAdjusting(billToAdjust); }} />}
      {adjusting && <AdjustmentDialog bill={adjusting} tz={tz} onClose={() => setAdjusting(null)} onSaved={() => { invalidate([BILLS_PATH, PERIODS_PATH, `${PERIODS_PATH}/${period.id}`]); void refetch(); }} />}
    </div>
  );
}

function BillDetailsDialog({ bill, tz, onClose, onAdjust }: { bill: BillRow; tz: string; onClose: () => void; onAdjust: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-strong rounded-2xl border-0 p-0 sm:max-w-md"><div className="flex max-h-[85vh] flex-col"><div className="px-5 pt-5 sm:px-6 sm:pt-6"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2.5 min-w-0"><span aria-hidden className="glass-inset flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-primary">{initialsOf(bill.residentName ?? "Resident")}</span><div className="min-w-0"><DialogTitle className="text-left text-base font-semibold tracking-tight truncate">{bill.residentName ?? "Resident"}</DialogTitle><p className="kpi-num text-xs text-muted-foreground font-mono mt-0.5">{bill.billNumber}</p></div></div><StatusBadge status={bill.status} /></div><DialogDescription className="mt-2 text-left text-[12px] leading-relaxed text-muted-foreground">Generated {fmtDateTime(bill.generatedAt, tz)} · Due {bill.dueDate ? fmtDate(bill.dueDate) : "—"}</DialogDescription></div><div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 space-y-4"><div className="glass-inset grid grid-cols-3 gap-2 rounded-xl p-3 text-center"><KeyValue stacked label="Subtotal" value={<span className="kpi-num text-sm font-semibold"><Money minor={bill.subtotalMinor} /></span>} /><KeyValue stacked label="Paid" value={<span className="kpi-num text-sm font-semibold text-success"><Money minor={bill.paymentsMinor} /></span>} /><KeyValue stacked label="Due" value={<span className={cn("kpi-num text-sm font-bold", bill.totalDueMinor > 0 ? "text-warning" : "text-success")}><Money minor={bill.totalDueMinor} /></span>} /></div><div className="glass-inset space-y-2.5 rounded-xl p-3.5 text-xs"><div className="flex justify-between items-center text-muted-foreground"><span>Resident meals</span><span className="kpi-num font-semibold text-foreground">{bill.residentMealCount} meals</span></div><div className="flex justify-between items-center text-muted-foreground"><span>Guest meals</span><span className="kpi-num font-semibold text-foreground">{bill.guestMealCount} meals</span></div>{bill.adjustmentsMinor !== 0 && <div className="flex justify-between items-center text-muted-foreground"><span>Adjustments</span><span className="kpi-num font-semibold text-foreground"><Money minor={bill.adjustmentsMinor} withSign plain /></span></div>}{bill.period && <div className="flex justify-between items-center text-muted-foreground"><span>Period</span><span className="kpi-num font-semibold text-foreground">{bill.period.year}-{String(bill.period.month).padStart(2, "0")}</span></div>}</div><p className="text-[11px] leading-relaxed text-muted-foreground">Bills are immutable accounting records. To correct meals, fees, or disputes, apply a tracked bill adjustment below.</p></div><div className="safe-b flex items-center justify-between border-t border-border/50 px-5 py-3.5 sm:px-6"><GlassButton variant="ghost" size="sm" icon={<ArrowUpRight />} onClick={() => { onClose(); navigateTo(`/admin/residents/${bill.residentId}`); }}>Resident 360</GlassButton><div className="flex items-center gap-2"><GlassButton variant="ghost" size="sm" onClick={onClose}>Close</GlassButton><GlassButton variant="primary" size="sm" icon={<LockOpen />} onClick={onAdjust}>Adjustment…</GlassButton></div></div></div></DialogContent>
    </Dialog>
  );
}

function AdjustmentDialog({ bill, tz, onClose, onSaved }: { bill: BillRow; tz: string; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const amountValid = /^-?\d+(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) !== 0;
  const reasonValid = reason.trim().length >= 3;
  async function save() { setSaving(true); setFields({}); try { await postJson(`/api/v1/admin/bills/${bill.id}/adjustment`, { amount: amount.trim(), reason: reason.trim() }); toast.success("Bill adjusted", { description: `${bill.billNumber} · ${Number(amount) < 0 ? "reduced" : "increased"} by ₹${Math.abs(Number(amount)).toFixed(2)}` }); onSaved(); onClose(); } catch (err) { if (err instanceof ApiClientError && err.fields) setFields(err.fields); toast.error(errMessage(err)); } finally { setSaving(false); } }
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="glass-strong rounded-2xl border-0 p-0 sm:max-w-md"><div className="flex max-h-[82vh] flex-col"><div className="px-5 pt-5 sm:px-6 sm:pt-6"><DialogTitle className="text-left text-lg font-semibold tracking-tight">Adjust {bill.billNumber}</DialogTitle><DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">Closed-period corrections happen through adjustments only — the original bill stays intact and the change is audited.</DialogDescription></div><div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6"><div className="space-y-4"><div className="glass-inset grid grid-cols-3 gap-2 rounded-md p-3.5"><KeyValue stacked label="Subtotal" value={<Money minor={bill.subtotalMinor} />} /><KeyValue stacked label="Paid" value={<Money minor={bill.paymentsMinor} />} /><KeyValue stacked label="Due" value={<Money minor={bill.totalDueMinor} />} /></div><MoneyField label="Adjustment amount" value={amount} onChange={setAmount} allowNegative placeholder="-50.00 or 50.00" error={fields.amount ?? (amount.trim() !== "" && !amountValid ? "Use a non-zero amount like -50.00 or 50.00." : undefined)} hint="Negative reduces what the resident owes; positive increases it." /><TextAreaField label="Reason" value={reason} onChange={setReason} rows={2} maxLength={500} placeholder="Why is this correction needed? (required)" error={fields.reason ?? (reason.trim() !== "" && !reasonValid ? "A short reason is required." : undefined)} /><p className="kpi-num text-[11px] text-muted-foreground/75">Generated {fmtDateTime(bill.generatedAt, tz)}</p></div></div><div className="safe-b flex items-center justify-end gap-2 border-t border-border/50 px-5 py-4 sm:px-6"><GlassButton variant="ghost" onClick={onClose} disabled={saving}>Cancel</GlassButton><GlassButton variant="primary" loading={saving} disabled={!amountValid || !reasonValid} onClick={() => void save()}>Apply adjustment</GlassButton></div></div></DialogContent></Dialog>;
}
