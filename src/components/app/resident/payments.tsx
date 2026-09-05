"use client";

/**
 * Resident Payments (#/app/payments) — BoardOps composition, meals-page
 * anatomy: Month picker capsule → Action bar (Submit Payment, right-aligned)
 * → tone/glow KPIs from /api/v1/payments meta → ONE "Payments" section card
 * (Wallet icon header, search + status pills INSIDE) holding method-orb rows
 * with symmetrical balance & tactile Details button opening payment breakdown.
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  Calendar,
  ChevronRight,
  Clock,
  FileText,
  Hourglass,
  Landmark,
  Paperclip,
  RotateCcw,
  Smartphone,
  Wallet2,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";

import { useSession } from "@/hooks/use-session";
import { useApiQuery } from "@/hooks/use-api-query";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import { KpiCard } from "@/components/glass/KpiCard";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import GlassButton from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { EmptyState } from "@/components/glass/EmptyState";
import { ErrorState } from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropletFilterChips } from "@/components/glass/DropletFilterChips";
import { cn } from "@/lib/utils";

import { SearchInput } from "./_shared/ui";
import { useEnvelopeQuery } from "./_shared/api";
import { formatDateTimeInTz, formatMinor, todayKeyInTz } from "./_shared/format";
import { SubmitPaymentDialog, type PayableBill } from "./_shared/pay-dialog";
import type { BillingData, PaymentDto, PaymentMethod, PaymentsMeta, RefundDto } from "./_shared/types";

/** BoardOps METHOD_META — gradient orbs per method (UPI frost · CASH emerald
 *  · BANK amber · OTHER sky), mirroring the admin payments pattern. */
const METHOD_META: Record<
  PaymentMethod,
  { label: string; icon: LucideIcon; orb: string; chip: "frost" | "success" | "warning" | "neutral" }
> = {
  UPI: { label: "UPI", icon: Smartphone, orb: "frost", chip: "frost" },
  CASH: { label: "Cash", icon: Banknote, orb: "emerald", chip: "success" },
  BANK_TRANSFER: { label: "Bank transfer", icon: Landmark, orb: "amber", chip: "warning" },
  OTHER: { label: "Other", icon: Wallet2, orb: "sky", chip: "neutral" },
};

/** "2026-09" ± 1 → "2026-08" / "2026-10". */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Long month name for the picker pill ("September"). */
function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2026, (m ?? 1) - 1, 1));
}

/* ------------------------------------------------------------------ chips */

function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "frost";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-muted/70 text-muted-foreground border-border",
    success: "bg-success/12 text-success border-success/30",
    warning: "bg-warning/14 text-warning border-warning/35",
    danger: "bg-danger/12 text-danger border-danger/30",
    frost: "bg-primary/10 text-primary border-primary/28",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill border px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold whitespace-nowrap",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------- proof preview */

function ProofImage({
  fileId,
  alt,
  className,
}: {
  fileId: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!fileId || failed) {
    return (
      <div
        className={cn(
          "glass-inset flex h-32 w-full items-center justify-center rounded-xl text-muted-foreground [&_svg]:size-8",
          className
        )}
      >
        <FileText aria-hidden />
      </div>
    );
  }
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border/40 bg-background/40", className)}>
      <img
        src={`/api/v1/files/${fileId}`}
        alt={alt}
        className="max-h-72 w-full object-contain rounded-xl"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/* --------------------------------------------------------- payment detail dialog */

function PaymentDetailDialog({
  payment,
  onClose,
  tz,
}: {
  payment: PaymentDto | null;
  onClose: () => void;
  tz: string;
}) {
  if (!payment) return null;
  const methodMeta = METHOD_META[payment.method] ?? METHOD_META.OTHER;
  const MethodIcon = methodMeta.icon;

  return (
    <Dialog open={Boolean(payment)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-panel border-border/60 max-w-lg rounded-3xl p-5 sm:p-6 shadow-2xl">
        <DialogTitle className="flex items-center justify-between gap-3 text-base sm:text-lg font-bold">
          <div className="flex items-center gap-2.5 min-w-0">
            <MealOrb icon={<MethodIcon />} colorToken={methodMeta.orb} size="sm" />
            <div className="min-w-0">
              <span className="truncate">{payment.displayNumber}</span>
              <p className="text-xs font-normal text-muted-foreground">Payment details</p>
            </div>
          </div>
          <StatusBadge status={payment.status} />
        </DialogTitle>
        <DialogDescription className="sr-only">
          Details and verification status for payment {payment.displayNumber}
        </DialogDescription>

        <div className="space-y-4 pt-2">
          {/* Amount hero box */}
          <div className="glass-inset rounded-2xl p-4 text-center border border-border/40">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Amount Paid</p>
            <Money minor={payment.amountMinor} className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1" />
            <div className="mt-2 flex items-center justify-center gap-2">
              <Chip tone={methodMeta.chip}>{methodMeta.label}</Chip>
              {payment.reference && (
                <span className="kpi-num text-xs text-muted-foreground">
                  Ref: {payment.reference}
                </span>
              )}
            </div>
          </div>

          {/* Status notices */}
          {payment.status === "PENDING" && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning leading-relaxed">
              <p className="font-semibold">Under review</p>
              <p className="mt-0.5 text-muted-foreground">
                Your payment was submitted and is awaiting admin verification. Once approved, the funds will be added to your mess balance.
              </p>
            </div>
          )}

          {payment.status === "REJECTED" && payment.rejectionReason && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger leading-relaxed">
              <p className="font-semibold">Payment Rejected</p>
              <p className="mt-0.5">{payment.rejectionReason}</p>
            </div>
          )}

          {payment.status === "APPROVED" && (
            <div className="rounded-xl border border-success/30 bg-success/10 p-3 text-xs text-success leading-relaxed">
              <p className="font-semibold">Verified & Approved</p>
              <p className="mt-0.5 text-muted-foreground">
                This payment was verified and credited to your mess account.
              </p>
            </div>
          )}

          {/* Key values */}
          <div className="glass-inset rounded-2xl p-3.5 space-y-2 border border-border/40 text-xs">
            <div className="flex items-center justify-between py-1 border-b border-border/20">
              <span className="text-muted-foreground">Submitted on</span>
              <span className="kpi-num font-medium text-foreground">{formatDateTimeInTz(payment.submittedAt, tz)}</span>
            </div>
            {payment.reviewedAt && (
              <div className="flex items-center justify-between py-1 border-b border-border/20">
                <span className="text-muted-foreground">Reviewed on</span>
                <span className="kpi-num font-medium text-foreground">{formatDateTimeInTz(payment.reviewedAt, tz)}</span>
              </div>
            )}
            {payment.reference && (
              <div className="flex items-center justify-between py-1 border-b border-border/20">
                <span className="text-muted-foreground">Reference / UTR</span>
                <span className="kpi-num font-mono font-medium text-foreground">{payment.reference}</span>
              </div>
            )}
            {payment.notes && (
              <div className="py-1">
                <span className="text-muted-foreground block mb-0.5">Note</span>
                <span className="font-medium text-foreground">{payment.notes}</span>
              </div>
            )}
          </div>

          {/* Attached Proof */}
          {payment.hasProof && payment.proofFileId && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <Paperclip className="size-3.5 text-primary" /> Attached Proof
              </p>
              <ProofImage fileId={payment.proofFileId} alt={`Payment proof for ${payment.displayNumber}`} />
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <GlassButton onClick={onClose} variant="secondary" className="w-full sm:w-auto px-6">
            Close
          </GlassButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------- main component */

export default function ResidentPayments() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<string>("PENDING");
  const [search, setSearch] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<PaymentDto | null>(null);

  const clientToday = todayKeyInTz(tz);
  const thisMonthKey = clientToday.slice(0, 7);
  const activeMonthKey = monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;

  const paymentsQuery = useEnvelopeQuery<PaymentDto[], PaymentsMeta>("/api/v1/payments", {
    status: filter === "ALL" || filter === "REFUNDS" ? undefined : filter,
    month: monthParam,
  });
  const refundsQuery = useEnvelopeQuery<RefundDto[]>("/api/v1/refunds");
  const billingQuery = useApiQuery<BillingData>("/api/v1/billing", undefined, { staleTime: 60_000 });

  const payments = paymentsQuery.data?.data ?? [];
  const meta = paymentsQuery.data?.meta;

  const payableBills: PayableBill[] = useMemo(() => {
    const unsettled = (billingQuery.data?.myBills ?? []).filter(
      (b) => !["PAID", "SETTLED", "VOIDED"].includes(b.status)
    );
    return unsettled.map((b) => ({
      id: b.id,
      billNumber: b.billNumber,
      year: b.period.year,
      month: b.period.month,
      totalDueMinor: b.totalDueMinor,
      status: b.status,
    }));
  }, [billingQuery.data]);

  /** Client-side search over the fetched page (number, reference, method). */
  const visiblePayments = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return payments;
    return payments.filter((p) => {
      const method = METHOD_META[p.method]?.label ?? p.method;
      return (
        p.displayNumber.toLowerCase().includes(q) ||
        (p.reference ?? "").toLowerCase().includes(q) ||
        method.toLowerCase().includes(q)
      );
    });
  }, [payments, search]);

  const visibleRefunds = useMemo(() => {
    const q = search.trim().toLowerCase();
    const refunds = refundsQuery.data?.data ?? [];
    if (!q) return refunds;
    return refunds.filter((r) => {
      return (
        (r.reason ?? "").toLowerCase().includes(q) ||
        (r.destination ?? "").toLowerCase().includes(q) ||
        r.mode.toLowerCase().includes(q)
      );
    });
  }, [refundsQuery.data, search]);

  const pendingCount = meta?.pendingCount ?? 0;

  const chips = useMemo(
    () => [
      { value: "PENDING", label: "Pending", count: meta?.pendingCount },
      { value: "ALL", label: "All" },
      { value: "APPROVED", label: "Approved" },
      { value: "REJECTED", label: "Rejected" },
      { value: "VOIDED", label: "Voided" },
      { value: "REFUNDS", label: "Refunds" },
    ],
    [meta]
  );

  const availableMinor =
    meta?.totalAvailableMinor ?? billingQuery.data?.creditsBreakdown?.availableMinor ?? 0;

  return (
    <>
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

        {/* Tone/Glow KPIs */}
        <StaggerItem>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <KpiCard
              label="Total Deposits"
              value={formatMinor(meta?.depositsThisMonth ?? 0)}
              sub={isThisMonth ? "This month" : monthLongName(activeMonthKey)}
              icon={<Wallet />}
              tone="success"
              glow="success"
              index={0}
              loading={paymentsQuery.isPending}
            />
            <KpiCard
              label="Total Available"
              value={formatMinor(availableMinor)}
              sub={availableMinor < 0 ? "Deficit" : "Available funds"}
              icon={<Landmark />}
              tone={availableMinor < 0 ? "danger" : "primary"}
              glow={availableMinor < 0 ? "danger" : "primary"}
              index={1}
              loading={paymentsQuery.isPending && !billingQuery.data}
            />
            <KpiCard
              label="Refunds"
              value={
                meta?.refundPendingCount
                  ? `${meta.refundPendingCount} Pending`
                  : meta?.refundsThisMonthFormatted ?? "₹0.00"
              }
              sub={meta?.refundPendingCount ? "In review" : (meta?.refundsThisMonth ?? 0) > 0 ? "Cash returned" : "No cash refunds"}
              icon={<RotateCcw />}
              tone="primary"
              glow="primary"
              index={2}
              loading={paymentsQuery.isPending}
              onClick={() => setFilter("REFUNDS")}
            />
          </div>
        </StaggerItem>

        {/* Centered Submit Payment button after KPIs */}
        <StaggerItem>
          <div className="flex justify-center">
            <GlassButton
              variant="primary"
              icon={<Wallet />}
              onClick={() => setPayOpen(true)}
            >
              Submit Payment
            </GlassButton>
          </div>
        </StaggerItem>

        {/* ONE section card — matches admin payments design & meals-page anatomy:
            Icon + title + count header, search + filter pills INSIDE, method-orb rows below. */}
        <StaggerItem>
          <GlassCard className="p-4 border border-border/40">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  {filter === "REFUNDS" ? <RotateCcw className="size-5" aria-hidden /> : <Wallet className="size-5" aria-hidden />}
                </span>
                <h3 className="font-semibold text-base">{filter === "REFUNDS" ? "Refunds & Adjustments" : "Payments"}</h3>
              </div>
            </div>

            <div className="mb-3 space-y-3">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={filter === "REFUNDS" ? "Search by reason, mode or destination…" : "Search by number, reference or method…"}
              />
              <DropletFilterChips
                chips={chips}
                value={filter}
                onChange={setFilter}
                layoutId="resident-payments-chips"
                aria-label="Filter payments"
              />
            </div>

            {filter === "REFUNDS" ? (
              refundsQuery.isPending ? (
                <ListSkeleton rows={4} />
              ) : refundsQuery.isError ? (
                <ErrorState
                  code={refundsQuery.error?.code}
                  message={refundsQuery.error?.message}
                  onRetry={() => void refundsQuery.refetch()}
                />
              ) : visibleRefunds.length === 0 ? (
                <EmptyState
                  icon={RotateCcw}
                  title={search ? "No refunds match" : "No refunds yet"}
                  description={
                    search
                      ? "Try a different search query."
                      : "When an administrator processes a refund or carry-forward for your account, it will appear here."
                  }
                />
              ) : (
                <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  {visibleRefunds.map((r, i) => (
                    <motion.div
                      key={r.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                    >
                      <GlassCard className="overflow-hidden rounded-2xl border border-border/40">
                        <div className="p-3 sm:p-3.5">
                          {/* Top row: Identity & Time (Left), Amount (Right) */}
                          <div className="flex h-10 items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <MealOrb icon={<RotateCcw />} colorToken="sky" size="sm" />
                              <div className="min-w-0">
                                <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                                  {r.mode === "CARRY_FORWARD" ? "Carried Forward" : "Refund Issued"}
                                </h4>
                                <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                                  <Clock className="size-3 shrink-0" aria-hidden />
                                  {formatDateTimeInTz(r.createdAt, tz)}
                                </p>
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              <Money minor={r.amountMinor} className="text-base sm:text-lg font-bold text-foreground block leading-tight" />
                              <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                                {r.mode === "CARRY_FORWARD" ? "credited" : "refunded"}
                              </span>
                            </div>
                          </div>

                          {/* Bottom row: Badges and details */}
                          <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                            <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                              <StatusBadge status={r.status} />
                              <Chip tone={r.mode === "CARRY_FORWARD" ? "frost" : "success"} className="text-[10px] px-2 py-0.5 shrink-0">
                                {r.mode === "CARRY_FORWARD" ? "Carry Forward" : "Paid Out"}
                              </Chip>
                              {r.destination && (
                                <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[140px]" title={r.destination}>
                                  To: {r.destination}
                                </span>
                              )}
                              <span className="text-[11px] text-muted-foreground truncate max-w-[180px]" title={r.reason}>
                                {r.reason}
                              </span>
                            </div>
                          </div>
                        </div>
                      </GlassCard>
                    </motion.div>
                  ))}
                </div>
              )
            ) : paymentsQuery.isPending ? (
              <ListSkeleton rows={5} />
            ) : paymentsQuery.isError ? (
              <ErrorState
                code={paymentsQuery.error?.code}
                message={paymentsQuery.error?.message}
                onRetry={() => void paymentsQuery.refetch()}
              />
            ) : visiblePayments.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title={
                  search
                    ? "No payments match"
                    : filter === "ALL"
                      ? "No payments yet"
                      : `No ${filter.toLowerCase()} payments`
                }
                description={
                  search
                    ? "Try a different search or filter."
                    : filter === "ALL"
                      ? "When you submit money to the mess, it will show up here with its status."
                      : "Try another filter to see your other payments."
                }
              />
            ) : (
              <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                {visiblePayments.map((p, i) => {
                  const methodMeta = METHOD_META[p.method] ?? METHOD_META.OTHER;
                  const MethodIcon = methodMeta.icon;
                  return (
                    <motion.div
                      key={p.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                    >
                      <GlassCard className="overflow-hidden rounded-2xl border border-border/40">
                        <div
                          className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                          onClick={() => setSelectedPayment(p)}
                        >
                          {/* Top row: Identity & Time (Left), Amount & Type (Right) — symmetrical balance */}
                          <div className="flex h-10 items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <MealOrb icon={<MethodIcon />} colorToken={methodMeta.orb} size="sm" />
                              <div className="min-w-0">
                                <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                                  {p.displayNumber} · {methodMeta.label}
                                </h4>
                                <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                                  <Clock className="size-3 shrink-0" aria-hidden />
                                  {formatDateTimeInTz(p.submittedAt, tz)}
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
                              {p.reference && (
                                <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[120px]" title={p.reference}>
                                  Ref {p.reference}
                                </span>
                              )}
                              {p.hasProof && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] text-primary font-medium shrink-0">
                                  <Paperclip className="size-3" aria-hidden /> Proof
                                </span>
                              )}
                              {p.status === "REJECTED" && p.rejectionReason && (
                                <span className="text-[11px] font-medium text-danger truncate max-w-[140px]" title={p.rejectionReason}>
                                  {p.rejectionReason}
                                </span>
                              )}
                            </div>

                            {/* Details button in a tactile glass pill */}
                            <motion.button
                              type="button"
                              whileTap={{ scale: 0.94 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedPayment(p);
                              }}
                              aria-label={`Open details for payment ${p.displayNumber}`}
                              className="glass-inset hover:glass-soft border border-border/40 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            >
                              <span>Details</span>
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
          </GlassCard>
        </StaggerItem>
      </StaggerGroup>

      {/* Payment details modal */}
      <PaymentDetailDialog
        payment={selectedPayment}
        onClose={() => setSelectedPayment(null)}
        tz={tz}
      />

      {/* Submit payment dialog */}
      <SubmitPaymentDialog open={payOpen} onOpenChange={setPayOpen} bills={payableBills} />
    </>
  );
}
