"use client";

/**
 * Admin Payments — BoardOps composition, meals-page anatomy: tone/glow
 * KPIs, then ONE section card (Wallet icon + title + count + search +
 * filter pills INSIDE) holding method-orb rows (pending rows carry quick
 * approve/reject that reuse the exact review mutation + reason-required
 * ConfirmDialog flow), and the proof-preview review dialog kept from the
 * original build.
 * GET /api/v1/admin/payments?status=&q= · GET /payments/:id · POST /approve|reject|void
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eye,
  Landmark,
  Paperclip,
  RotateCcw,
  Smartphone,
  Sparkles,
  Trash2,
  Wallet,
  Wallet2,
  Wand2,
  XCircle,
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { navigateTo } from "@/hooks/use-hash-route";
import { useSession } from "@/hooks/use-session";
import { ApiClientError, api } from "@/lib/api";
import { useApiMetaQuery, errMessage, useInvalidate, metaNum, metaStr } from "./_shared/api";
import { SearchField } from "./_shared/fields";
import { Chip, FilterChips, KpiGrid, KeyValue, ProofImage } from "./_shared/chrome";
import { fmtDateTime, monthLabel, todayKey } from "./_shared/format";
import { RefundDialog } from "./_shared/refund-dialog";
import type { PaymentDetail, PaymentRow } from "./_shared/types";

const PAYMENTS_PATH = "/api/v1/admin/payments";

interface RefundRow {
  id: string;
  residentId: string;
  residentName: string;
  amountMinor: number;
  amountFormatted: string;
  mode: "ISSUE_REFUND" | "CARRY_FORWARD";
  reason: string;
  destination: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

interface RefundCandidate {
  residentId: string;
  residentName: string;
  roomNumber: string | null;
  email: string;
  refundableMinor: number;
  refundableFormatted: string;
  creditsMinor: number;
  creditsFormatted: string;
  chargesMinor: number;
  chargesFormatted: string;
  refundsIssuedMinor: number;
  refundsIssuedFormatted: string;
  latestBill: {
    id: string;
    billNumber: string;
    billingPeriodId: string;
    year: number;
    month: number;
    generatedAt: string;
  };
}

/** BoardOps METHOD_META — gradient orbs per method (UPI frost · CASH emerald
 *  · BANK amber · OTHER sky) + the compact method chip tone. */
const METHOD_META: Record<string, { label: string; icon: LucideIcon; orb: string; chip: "frost" | "success" | "warning" | "neutral" }> = {
  UPI: { label: "UPI", icon: Smartphone, orb: "frost", chip: "frost" },
  CASH: { label: "Cash", icon: Banknote, orb: "emerald", chip: "success" },
  BANK_TRANSFER: { label: "Bank transfer", icon: Landmark, orb: "amber", chip: "warning" },
  OTHER: { label: "Other", icon: Wallet2, orb: "sky", chip: "neutral" },
};

type ReviewAction = "approve" | "reject" | "void";

const REVIEW_ACTION_META: Record<ReviewAction, { title: string; description: string; confirm: string; toast: string }> = {
  approve: {
    title: "Approve payment",
    description: "The money is recorded in the ledger and added to the resident's available funds immediately.",
    confirm: "Approve",
    toast: "Payment approved",
  },
  reject: {
    title: "Reject payment",
    description: "The resident is notified with your reason. No money moves — they can submit again.",
    confirm: "Reject payment",
    toast: "Payment rejected",
  },
  void: {
    title: "Void approved payment",
    description: "A reversal journal is posted — the money leaves the resident's funds and the audit trail keeps both entries. Approved payments are never deleted.",
    confirm: "Void payment",
    toast: "Payment voided",
  },
};

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

/** "Sep 2025" for the month-scoped KPI label. */
function monthShortLabel(key: string): string {
  return monthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7)));
}

export default function AdminPayments() {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [status, setStatus] = useState(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#/admin/payments/refunds")
      ? "REFUND_CENTER"
      : "PENDING"
  );
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [refundTarget, setRefundTarget] = useState<RefundCandidate | null>(null);
  const [acting, setActing] = useState(false);
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  useEffect(() => {
    const t = window.setTimeout(() => setAppliedSearch(search.trim()), 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data, isLoading, error, refetch } = useApiMetaQuery<PaymentRow[]>(PAYMENTS_PATH, {
    status: status === "ALL" || status === "REFUNDS" || status === "REFUND_CENTER" ? undefined : status,
    q: status === "REFUND_CENTER" ? undefined : appliedSearch || undefined,
    month: monthParam,
  });

  const refundsQuery = useApiMetaQuery<RefundRow[]>("/api/v1/admin/refunds", undefined, {
    enabled: status === "REFUNDS",
  });
  const refundCandidatesQuery = useApiMetaQuery<RefundCandidate[]>(
    "/api/v1/admin/refunds/eligible",
    { q: status === "REFUND_CENTER" ? appliedSearch || undefined : undefined },
    { staleTime: 5_000 }
  );

  const payments = data?.data ?? [];
  const meta = data?.meta ?? {};
  const refundCandidates = refundCandidatesQuery.data?.data ?? [];
  const refundCandidateMeta = refundCandidatesQuery.data?.meta ?? {};
  const refundCandidateCount = metaNum(refundCandidateMeta, "candidateCount") ?? refundCandidates.length;
  const hasGeneratedBills = refundCandidateMeta.hasGeneratedBills === true;

  const sortedPayments = useMemo(() => {
    return [...payments].sort((a, b) => {
      const pA = a.status === "PENDING" ? 0 : 1;
      const pB = b.status === "PENDING" ? 0 : 1;
      if (pA !== pB) return pA - pB;
      return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
    });
  }, [payments]);

  const thisMonthKey = todayKey().slice(0, 7);
  const activeMonthKey = metaStr(meta, "month") ?? monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;

  const chips = useMemo(
    () => [
      { value: "PENDING", label: "Pending", count: metaNum(meta, "pendingApproval") ?? undefined },
      { value: "ALL", label: "All" },
      { value: "APPROVED", label: "Approved" },
      { value: "REJECTED", label: "Rejected" },
      { value: "VOIDED", label: "Voided" },
      { value: "REFUNDS", label: "Refunds" },
    ],
    [meta]
  );

  const detailQuery = useApiQuery<PaymentDetail>(reviewId ? `${PAYMENTS_PATH}/${reviewId}` : null);
  const detail = detailQuery.data;

  async function runAction(kind: ReviewAction, reason?: string) {
    if (!reviewId) return;
    setActing(true);
    try {
      await postJson(`${PAYMENTS_PATH}/${reviewId}/${kind}`, kind === "approve" ? {} : { reason });
      const detailPath = `${PAYMENTS_PATH}/${reviewId}`;
      invalidate([PAYMENTS_PATH, detailPath, "/api/v1/admin/funds", "/api/v1/admin/dashboard", "/api/v1/admin/refunds/eligible"]);
      toast.success(REVIEW_ACTION_META[kind].toast, {
        description: detail ? `${detail.resident.fullName} · ${detail.payment.amountFormatted}` : undefined,
      });
      setAction(null);
      setReviewId(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={(error as ApiClientError | undefined)?.code}
          message={(error as ApiClientError | undefined)?.message}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const actionMeta = action ? REVIEW_ACTION_META[action] : null;
  const pendingCount = metaNum(meta, "pendingApproval") ?? 0;

  return (
    <StaggerGroup className="space-y-4">
      {/* Month capsule — circular arrows + reset pill (BoardOps picker) */}
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
        loading={isLoading && !data}
        kpis={[
          {
            label: "Received",
            value: metaStr(meta, "receivedThisMonthFormatted") ?? "₹0.00",
            icon: <Wallet />,
            sub: "Deposits",
            tone: "success",
            glow: "success",
            onClick: () => setStatus("APPROVED"),
          },
          {
            label: "Pending",
            value: String(pendingCount),
            icon: <Clock />,
            sub: pendingCount > 0 ? "Needs review" : "All clear",
            tone: "warning",
            glow: "warning",
            onClick: () => setStatus("PENDING"),
          },
          {
            label: "Refunds",
            value: metaStr(meta, "refundsThisMonthFormatted") ?? "₹0.00",
            icon: <RotateCcw />,
            sub: "Processed",
            tone: "primary",
            glow: "primary",
            onClick: () => setStatus("REFUNDS"),
          },
        ]}
      />
      </StaggerItem>

      {hasGeneratedBills && (
        <StaggerItem>
          <div className="flex justify-center">
            <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}>
              <GlassButton variant="primary" icon={<RotateCcw />} onClick={() => setStatus("REFUND_CENTER")}>
                Refund Center{refundCandidateCount > 0 ? ` · ${refundCandidateCount}` : ""}
              </GlassButton>
            </motion.div>
          </div>
        </StaggerItem>
      )}

      {/* ONE section card — meals-page anatomy: icon + title + count header,
          search + filter pills INSIDE, compact method-orb rows below. */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <motion.span
            key={status === "REFUND_CENTER" || status === "REFUNDS" ? "refund" : "payment"}
            initial={{ scale: 0.8, opacity: 0, rotate: -8 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"
          >
            {status === "REFUND_CENTER" || status === "REFUNDS" ? <RotateCcw className="size-5" aria-hidden /> : <Wallet className="size-5" aria-hidden />}
          </motion.span>
          <h3 className="font-semibold text-base">
            {status === "REFUND_CENTER" ? "Refund Center" : status === "REFUNDS" ? "Refund history" : "Payments"}
          </h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={status === "REFUND_CENTER" ? "Search overpaid residents…" : status === "REFUNDS" ? "Search refund history…" : "Search by number, name or reference…"}
          />
          <FilterChips chips={chips} value={status} onChange={setStatus} layoutId="admin-payments-chips" />
        </div>

        <AnimatePresence mode="wait" initial={false}>
        {status === "REFUND_CENTER" ? (
          <motion.div key="refund-center" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
            {refundCandidatesQuery.isLoading && !refundCandidatesQuery.data ? (
              <ListSkeleton rows={4} />
            ) : refundCandidatesQuery.error ? (
              <ErrorState code={(refundCandidatesQuery.error as ApiClientError).code} message={(refundCandidatesQuery.error as ApiClientError).message} onRetry={() => void refundCandidatesQuery.refetch()} />
            ) : refundCandidates.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="No overpayments to resolve"
                description="After billing, residents with excess approved credit appear here. Carry-forward decisions stay resolved until a newer bill is generated."
              />
            ) : (
              <div className="no-scrollbar max-h-[30rem] space-y-2 overflow-y-auto pr-1">
                {refundCandidates.map((candidate, i) => (
                  <motion.div key={candidate.residentId} initial={{ opacity: 0, y: 8, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}>
                    <GlassCard className="overflow-hidden rounded-2xl">
                      <div className="p-3 sm:p-3.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <MealOrb icon={<RotateCcw />} colorToken="emerald" size="sm" />
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-semibold text-foreground">{candidate.residentName}</h4>
                              <p className="truncate text-xs text-muted-foreground">{candidate.roomNumber ? `Room ${candidate.roomNumber} · ` : ""}{candidate.latestBill.billNumber}</p>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <Money minor={candidate.refundableMinor} className="block text-base font-bold text-success sm:text-lg" />
                            <span className="text-[11px] font-medium text-muted-foreground">excess credit</span>
                          </div>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/15 pt-2">
                          <div className="no-scrollbar flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-muted-foreground">
                            <span className="shrink-0">Paid <Money minor={candidate.creditsMinor} plain className="font-semibold" /></span>
                            <span className="shrink-0">Billed <Money minor={candidate.chargesMinor} plain className="font-semibold" /></span>
                            {candidate.refundsIssuedMinor > 0 && <span className="shrink-0">Returned <Money minor={candidate.refundsIssuedMinor} plain className="font-semibold" /></span>}
                          </div>
                          <GlassButton size="sm" variant="primary" icon={<RotateCcw />} onClick={() => setRefundTarget(candidate)}>Resolve</GlassButton>
                        </div>
                      </div>
                    </GlassCard>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        ) : status === "REFUNDS" ? (
          refundsQuery.isLoading ? (
            <ListSkeleton rows={5} />
          ) : (refundsQuery.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={RotateCcw}
              title="No refunds recorded"
              description="Refunds and excess credit resolutions will appear here."
            />
          ) : (
            <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {(refundsQuery.data?.data ?? []).map((ref, i) => (
                <motion.div
                  key={ref.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                >
                  <GlassCard className="overflow-hidden rounded-2xl">
                    <div
                      className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                      onClick={() => navigateTo(`/admin/residents/${ref.residentId}`)}
                    >
                      {/* Top row */}
                      <div className="flex h-10 items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <MealOrb
                            icon={<RotateCcw />}
                            colorToken={ref.mode === "ISSUE_REFUND" ? "amber" : "emerald"}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                              {ref.residentName}
                            </h4>
                            <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <Clock className="size-3 shrink-0" aria-hidden />
                              {fmtDateTime(ref.createdAt, tz)}
                            </p>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <Money
                            minor={ref.amountMinor}
                            className="text-base sm:text-lg font-bold text-foreground block leading-tight"
                          />
                          <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                            {ref.mode === "ISSUE_REFUND" ? "payout" : "carried forward"}
                          </span>
                        </div>
                      </div>

                      {/* Bottom row */}
                      <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <Chip tone={ref.mode === "ISSUE_REFUND" ? "warning" : "frost"} className="text-[10px] px-2 py-0.5 shrink-0">
                            {ref.mode === "ISSUE_REFUND" ? "Payout" : "Carry forward"}
                          </Chip>
                          <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[200px]" title={ref.reason}>
                            {ref.reason}
                          </span>
                          {ref.destination && (
                            <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[140px]" title={ref.destination}>
                              · {ref.destination}
                            </span>
                          )}
                        </div>

                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateTo(`/admin/residents/${ref.residentId}`);
                          }}
                          aria-label={`View resident 360 for ${ref.residentName}`}
                          className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span>Resident</span>
                          <ChevronRight className="size-3" aria-hidden />
                        </motion.button>
                      </div>
                    </div>
                  </GlassCard>
                </motion.div>
              ))}
            </div>
          )
        ) : isLoading && !data ? (
          <ListSkeleton rows={5} />
        ) : payments.length === 0 ? (
          status === "PENDING" ? (
            <EmptyState
              icon={Wallet}
              title="No pending payments"
              description="Payments submitted by residents will appear here."
            />
          ) : (
            <EmptyState
              icon={Wallet}
              title={appliedSearch || status !== "ALL" ? "No payments match" : "No payments yet"}
              description={appliedSearch || status !== "ALL" ? "Try a different filter or search." : "Submitted payments will appear here."}
            />
          )
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {sortedPayments.map((p, i) => {
              const methodMeta = METHOD_META[p.method] ?? METHOD_META.OTHER;
              const MethodIcon = methodMeta.icon;
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                >
                  <GlassCard className="overflow-hidden rounded-2xl">
                    <div
                      className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                      onClick={() => setReviewId(p.id)}
                    >
                    {/* Top row: Identity & Time (Left), Amount & Type (Right) — symmetrical balance */}
                    <div className="flex h-10 items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MealOrb icon={<MethodIcon />} colorToken={methodMeta.orb} size="sm" />
                        <div className="min-w-0">
                          <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                            {p.residentName}
                          </h4>
                          <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                            <Clock className="size-3 shrink-0" aria-hidden />
                            {fmtDateTime(p.submittedAt, tz)}
                          </p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <Money minor={p.amountMinor} className="text-base sm:text-lg font-bold text-foreground block leading-tight" />
                        <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                          deposited
                        </span>
                      </div>
                    </div>

                    {/* Bottom row: Badges on left, Details in a pill on right — strictly 1 row for symmetrical heights */}
                    <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                      <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        <StatusBadge status={p.status} />
                        <Chip tone={methodMeta.chip} className="text-[10px] px-2 py-0.5 shrink-0">
                          {methodMeta.label}
                        </Chip>
                        <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                          {p.displayNumber}
                        </span>
                        {p.reference && (
                          <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[110px]" title={p.reference}>
                            Ref {p.reference}
                          </span>
                        )}
                        {p.hasProof && (
                          <span className="inline-flex items-center gap-0.5 text-[11px] text-primary font-medium shrink-0">
                            <Paperclip className="size-3" aria-hidden /> Proof
                          </span>
                        )}
                      </div>

                      {/* Details button in a tactile glass pill */}
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.94 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setReviewId(p.id);
                        }}
                        aria-label={`Open details for payment ${p.displayNumber}`}
                        className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <span>{p.status === "PENDING" ? "Review" : "Details"}</span>
                        <ChevronRight className="size-3" aria-hidden />
                      </motion.button>
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
              );
            })}
          </div>
        )}
        </AnimatePresence>
      </GlassCard>
      </StaggerItem>

      {refundTarget && (
        <RefundDialog
          open
          onOpenChange={(open) => !open && setRefundTarget(null)}
          residentId={refundTarget.residentId}
          residentName={refundTarget.residentName}
          availableMinor={refundTarget.refundableMinor}
          latestBillNumber={refundTarget.latestBill.billNumber}
          billingPeriodLabel={monthShortLabel(`${refundTarget.latestBill.year}-${String(refundTarget.latestBill.month).padStart(2, "0")}`)}
          onSaved={() => {
            invalidate(["/api/v1/admin/refunds/eligible", "/api/v1/admin/refunds", PAYMENTS_PATH, "/api/v1/admin/funds", "/api/v1/admin/dashboard", "/api/v1/admin/billing"]);
            setRefundTarget(null);
          }}
        />
      )}

      {/* ------------------------------ review dialog ------------------------------ */}
      {reviewId && (
        <ReviewDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setReviewId(null);
              setAction(null);
            }
          }}
          loading={detailQuery.isLoading}
          error={detailQuery.error as ApiClientError | null}
          detail={detail}
          tz={tz}
          onAction={(kind) => setAction(kind)}
        />
      )}

      {action && actionMeta && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAction(null)}
          title={actionMeta.title}
          description={
            <>
              {actionMeta.description}
              {detail && (
                <span className="mt-2 block font-medium">
                  {detail.resident.fullName} · {detail.payment.amountFormatted}
                </span>
              )}
            </>
          }
          confirmLabel={actionMeta.confirm}
          tone={action === "approve" ? "primary" : "destructive"}
          requireReason={action !== "approve"}
          reasonPlaceholder={action === "reject" ? "Why is this being rejected? (required)" : "Why is this being voided? (required)"}
          loading={acting}
          onConfirm={(reason) => void runAction(action, reason)}
        />
      )}
    </StaggerGroup>
  );
}

/* ------------------------------------------------------------ review dialog */

type AiSuggestion = {
  suggestion: { amount?: string | null; method?: string | null; reference?: string | null; payer_or_note?: string | null; summary?: string | null } | null;
  raw?: string | null;
  disclaimer?: string;
};

function AiProofPanel({ fileId }: { fileId: string | null | undefined }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: AiSuggestion | null }>({
    loading: false,
    error: null,
    data: null,
  });
  if (!fileId) return null;
  const run = async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await api<AiSuggestion>("/api/v1/admin/ai/proof-preview", { method: "POST", json: { fileId } });
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : "AI preview failed.", data: null });
    }
  };
  return (
    <div className="glass-inset mt-2 rounded-md p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden /> AI assist
        </p>
        <GlassButton size="sm" variant="ghost" icon={<Wand2 />} loading={state.loading} onClick={() => void run()}>
          {state.data ? "Read again" : "Read proof"}
        </GlassButton>
      </div>
      {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}
      {state.data?.suggestion && (
        <div className="mt-2 space-y-1 text-sm">
          {state.data.suggestion.summary && <p className="text-foreground">{state.data.suggestion.summary}</p>}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Read amount: <span className="kpi-num font-medium text-foreground">{state.data.suggestion.amount ?? "—"}</span></span>
            <span>Read method: <span className="font-medium text-foreground">{state.data.suggestion.method ?? "—"}</span></span>
            <span className="col-span-2 truncate">Read reference: <span className="font-medium text-foreground">{state.data.suggestion.reference ?? "—"}</span></span>
          </div>
          <p className="pt-1 text-[11px] leading-snug text-muted-foreground">{state.data.disclaimer}</p>
        </div>
      )}
      {!state.data?.suggestion && state.data?.raw && (
        <p className="mt-2 text-xs text-muted-foreground">{state.data.raw}</p>
      )}
    </div>
  );
}

function ReviewDialog({
  open,
  onOpenChange,
  loading,
  error,
  detail,
  tz,
  onAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  error: ApiClientError | null;
  detail: PaymentDetail | null | undefined;
  tz: string;
  onAction: (kind: ReviewAction) => void;
}) {
  return (
    <ConfirmFreeDialog open={open} onOpenChange={onOpenChange} title="Payment review" wide>
      {loading ? (
        <div className="space-y-3 py-2">
          <ListSkeleton rows={4} />
        </div>
      ) : error ? (
        <ErrorState code={error.code} message={error.message} onRetry={undefined} />
      ) : detail ? (
        <div className="space-y-5">
          {/* proof */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proof</p>
            <ProofImage fileId={detail.payment.proofFileId} alt={`Proof for ${detail.payment.displayNumber}`} />
            <AiProofPanel fileId={detail.payment.proofFileId} />
          </div>

          {/* payment facts */}
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment</p>
            <KeyValue label="Amount" value={<span className="kpi-num text-base font-semibold">{detail.payment.amountFormatted}</span>} />
            <KeyValue label="Method" value={METHOD_META[detail.payment.method]?.label ?? detail.payment.method} />
            <KeyValue label="Reference" value={detail.payment.reference ?? "—"} />
            <KeyValue label="Status" value={<StatusBadge status={detail.payment.status} />} />
            {detail.payment.notes && <KeyValue label="Notes" value={detail.payment.notes} />}
            <KeyValue label="Submitted" value={fmtDateTime(detail.payment.submittedAt, tz)} />
            {detail.payment.reviewedAt && <KeyValue label="Reviewed" value={fmtDateTime(detail.payment.reviewedAt, tz)} />}
          </div>

          {/* resident balance summary */}
          {detail.residentFunds && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {detail.resident.fullName} · balance summary
              </p>
              <div className="glass-inset grid grid-cols-2 gap-3 rounded-md p-3.5">
                <KeyValue stacked label="Deposits" value={<Money minor={detail.residentFunds.creditsMinor} />} />
                <KeyValue stacked label="Pending" value={<Money minor={detail.residentFunds.pendingPaymentsMinor} />} />
                <KeyValue stacked label="Charges" value={<Money minor={detail.residentFunds.chargesMinor} />} />
                <KeyValue stacked label="Available" value={<Money minor={detail.residentFunds.availableMinor} />} />
              </div>
            </div>
          )}

          {/* actions */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {detail.payment.status === "PENDING" && (
              <>
                <GlassButton variant="destructive" icon={<XCircle />} onClick={() => onAction("reject")}>
                  Reject
                </GlassButton>
                <GlassButton variant="primary" icon={<CheckCircle2 />} onClick={() => onAction("approve")}>
                  Approve
                </GlassButton>
              </>
            )}
            {detail.payment.status === "APPROVED" && (
              <GlassButton variant="destructive" icon={<Trash2 />} onClick={() => onAction("void")}>
                Void…
              </GlassButton>
            )}
          </div>
        </div>
      ) : null}
    </ConfirmFreeDialog>
  );
}

/** Plain dialog shell without built-in buttons (local footers). */
function ConfirmFreeDialog({
  open,
  onOpenChange,
  title,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className={cn("glass-strong rounded-2xl border-0 p-0", wide ? "sm:max-w-xl" : "sm:max-w-md")}
      >
        <div className="flex max-h-[82vh] flex-col">
          <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">{title}</DialogTitle>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
