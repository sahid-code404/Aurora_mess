"use client";

/**
 * Resident Billing (#/app/billing) — the resident money page.
 * BoardOps composition, meals-page anatomy: action bar (Pay Bill,
 * right-aligned) → KPI trio → "Amount to Pay" section card (Wallet icon
 * header, compact orb rows + right-aligned Money) → running-estimate panel →
 * "Bills" section card (FileSpreadsheet icon header) with the bill history.
 * Current period running estimate + calculation provenance (spec §58) kept.
 * Plain language only: "Amount to Pay", no accounting jargon.
 */

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Calendar,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  Clock,
  FileSpreadsheet,
  Info,
  Receipt,
  Utensils,
  Wallet,
} from "lucide-react";

import { useSession } from "@/hooks/use-session";
import { KpiCard } from "@/components/glass/KpiCard";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import GlassButton from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import MealOrb from "@/components/glass/MealOrb";
import { EmptyState } from "@/components/glass/EmptyState";
import { ErrorState } from "@/components/glass/ErrorState";
import { KpiGridSkeleton, ListSkeleton } from "@/components/glass/LoadingSkeleton";
import Money from "@/components/glass/Money";

import { useApiQuery } from "@/hooks/use-api-query";
import { useEnvelopeQuery } from "./_shared/api";
import { formatDateInTz, formatMinor, monthLabel } from "./_shared/format";
import { DataRow, SheetDialog } from "./_shared/ui";
import { SubmitPaymentDialog, type PayableBill } from "./_shared/pay-dialog";
import { isMoneyUsable, type BillingData, type BillDto, type BillLineDto } from "./_shared/types";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";

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

function todayMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------- bill provenance --------------------------- */

const LINE_LABELS: Record<string, string> = {
  RESIDENT_MEALS: "Resident meals",
  GUEST_MEALS: "Guest meals",
  PAYMENTS_APPLIED: "Payments applied",
  ADJUSTMENTS: "Adjustments",
};

function BillLines({ bill }: { bill: BillDto }) {
  const lines = useMemo(
    () => [...(bill.lines ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [bill.lines]
  );

  return (
    <div className="space-y-1">
      {lines.map((line) => (
        <LineRow key={line.id} line={line} />
      ))}
      <DataRow label="Total to pay" value={<Money minor={bill.totalDueMinor} />} strong emphasized />
    </div>
  );
}

function LineRow({ line }: { line: BillLineDto }) {
  const label = LINE_LABELS[line.code] ?? line.label;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="min-w-0 text-[13px] text-muted-foreground">
        {label}
        {line.quantity != null && line.unitPriceMinor != null && (
          <span className="kpi-num">
            {" "}
            {line.quantity} × {formatMinor(line.unitPriceMinor)}
          </span>
        )}
      </span>
      <span className="kpi-num shrink-0 text-[13px] font-medium">
        {line.amountMinor < 0 ? "−" : ""}
        <Money minor={Math.abs(line.amountMinor)} />
      </span>
    </div>
  );
}

/** "How this was calculated" (spec §58 explanation, from line.detail). */
function CalculationExplanation({ bill }: { bill: BillDto }) {
  const mealLine = (bill.lines ?? []).find((l) => l.code === "RESIDENT_MEALS");
  const detail = mealLine?.detail;
  const mealCharge = bill.snapshot?.mealChargeMinor ?? bill.mealChargeMinor;

  return (
    <div className="glass-inset space-y-2 rounded-md p-3.5">
      <p className="text-[13px] font-semibold">How this was calculated</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {detail ? (
          <>
            The per-meal price comes from the mess formula:{" "}
            <span className="font-medium text-foreground/80">
              {mealLine?.detail?.formula ?? "(Total Market Cost − Guest Income) ÷ Resident Consumed Meals"}
            </span>
            . Market cost <span className="kpi-num">{formatMinor(detail.marketCostMinor)}</span> minus guest
            income <span className="kpi-num">{formatMinor(detail.guestIncomeMinor)}</span>, shared over{" "}
            <span className="kpi-num">{detail.totalMeals}</span> resident meals ={" "}
            <span className="kpi-num font-semibold text-foreground">
              {formatMinor(mealCharge)} per meal
            </span>
            . Your {bill.residentMealCount} meals are charged at that price.
          </>
        ) : (
          <>
            The per-meal price was fixed when this bill was generated from the month's market cost, guest
            income and the total resident meals of the house. Your {bill.residentMealCount} resident meals and{" "}
            {bill.guestMealCount} guest meals are charged on this bill.
          </>
        )}
      </p>
      {detail && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Guest meals are charged at the fixed guest price. Payments you made before the bill was
          generated are subtracted at the end.
        </p>
      )}
    </div>
  );
}

/* ------------------------------ bill detail sheet --------------------------- */

function BillDetailSheet({
  billId,
  onOpenChange,
  onPay,
  tz,
}: {
  billId: string | null;
  onOpenChange: (open: boolean) => void;
  onPay: (bill: BillDto) => void;
  tz: string;
}) {
  const query = useEnvelopeQuery<BillDto, Record<string, unknown>>(
    billId ? `/api/v1/bills/${billId}` : null
  );
  const [showCalc, setShowCalc] = useState(false);
  const bill = query.data?.data;

  return (
    <SheetDialog
      open={billId != null}
      onOpenChange={onOpenChange}
      title={bill ? monthLabel(bill.period.year, bill.period.month) : "Bill"}
      description={
        bill ? (
          <span className="kpi-num">
            {bill.billNumber} · generated {formatDateInTz(bill.generatedAt, tz)}
          </span>
        ) : (
          "Loading your bill…"
        )
      }
      footer={
        bill && bill.totalDueMinor > 0 && bill.status !== "PAID" ? (
          <GlassButton onClick={() => onPay(bill)}>Pay this bill</GlassButton>
        ) : undefined
      }
    >
      {query.isPending ? (
        <ListSkeleton rows={4} />
      ) : query.isError ? (
        <ErrorState code={query.error?.code} message={query.error?.message} onRetry={() => void query.refetch()} />
      ) : bill ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <StatusBadge status={bill.status} />
            {bill.dueDate && (
              <span className="kpi-num text-xs text-muted-foreground">
                Due {formatDateInTz(bill.dueDate, tz)}
              </span>
            )}
          </div>

          <div className="glass-inset rounded-md p-3.5">
            <BillLines bill={bill} />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowCalc((s) => !s)}
              aria-expanded={showCalc}
              className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-2 text-[13px] font-medium text-primary transition-colors hover:text-primary/80"
            >
              <span className="inline-flex items-center gap-1.5">
                <Info className="size-3.5" aria-hidden />
                View calculation
              </span>
              <ChevronDown
                className={cn("size-4 transition-transform", showCalc && "rotate-180")}
                aria-hidden
              />
            </button>
            <AnimatePresence initial={false}>
              {showCalc && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22 }}
                  className="overflow-hidden"
                >
                  <div className="pt-1">
                    <CalculationExplanation bill={bill} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      ) : null}
    </SheetDialog>
  );
}

/* --------------------------------- the view --------------------------------- */

const UNSETTLED_BLOCK = new Set(["PAID", "SETTLED", "VOIDED"]);

export default function ResidentBilling() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  const billingQuery = useApiQuery<BillingData>("/api/v1/billing");
  const billsQuery = useApiQuery<BillDto[]>("/api/v1/bills");

  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const [payOpen, setPayOpen] = useState(false);
  const [payPreset, setPayPreset] = useState<string | null>(null);
  const [detailBillId, setDetailBillId] = useState<string | null>(null);
  const [showEstimateCalc, setShowEstimateCalc] = useState(false);
  const [showActiveBillCalc, setShowActiveBillCalc] = useState(false);

  const thisMonthKey = todayMonthKey();
  const activeMonthKey = monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;
  const activeYear = Number(activeMonthKey.slice(0, 4));
  const activeMonth = Number(activeMonthKey.slice(5, 7));

  const billing = billingQuery.data;
  const bills = billsQuery.data ?? [];

  const activeBill = useMemo(
    () => bills.find((b) => b.period.year === activeYear && b.period.month === activeMonth) ?? null,
    [bills, activeYear, activeMonth]
  );

  const sortedBills = useMemo(() => {
    const now = new Date();
    return [...bills].sort((a, b) => {
      const isOverdue = (bill: BillDto) =>
        bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate && new Date(bill.dueDate) < now);
      const isActionNeeded = (bill: BillDto) => bill.totalDueMinor > 0;

      const getRank = (bill: BillDto) => {
        if (isOverdue(bill)) return 0;
        if (isActionNeeded(bill)) return 1;
        return 2;
      };

      const rA = getRank(a);
      const rB = getRank(b);
      if (rA !== rB) return rA - rB;

      if (rA === 0 || rA === 1) {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
      }

      return new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime();
    });
  }, [bills]);

  const unsettled = useMemo(
    () => (billing?.myBills ?? []).filter((b) => !UNSETTLED_BLOCK.has(b.status)),
    [billing]
  );
  const payableBills: PayableBill[] = unsettled.map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    year: b.period.year,
    month: b.period.month,
    totalDueMinor: b.totalDueMinor,
    status: b.status,
  }));

  const activePayableBill: PayableBill | null =
    activeBill && activeBill.totalDueMinor > 0 && activeBill.status !== "PAID"
      ? {
          id: activeBill.id,
          billNumber: activeBill.billNumber,
          year: activeBill.period.year,
          month: activeBill.period.month,
          totalDueMinor: activeBill.totalDueMinor,
          status: activeBill.status,
        }
      : null;

  if (billingQuery.isPending) {
    return (
      <div className="space-y-4">
        <KpiGridSkeleton
          count={3}
          className="grid-cols-2 sm:grid-cols-3"
        />
        <div className="glass-skeleton h-40 w-full rounded-lg" />
        <ListSkeleton rows={4} />
      </div>
    );
  }

  if (billingQuery.isError || !billing) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={billingQuery.error?.code}
          message={billingQuery.error?.message}
          onRetry={() => void billingQuery.refetch()}
        />
      </div>
    );
  }

  const guestEstimateMinor = billing.myGuestCount * billing.guestPriceMinor;

  return (
    <>
      <StaggerGroup className="space-y-4">
        {/* Month capsule — circular arrows + reset pill (BoardOps picker matching admin billing) */}
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

        {/* KPI cards — month aware (matches meals & admin billing behavior) */}
        <StaggerItem>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {isThisMonth ? (
              <>
                <KpiCard
                  label="Due"
                  value={billing.currentAmountToPayFormatted}
                  sub="Unsettled"
                  icon={<Wallet />}
                  glow="warning"
                  tone="warning"
                  index={0}
                />
                <KpiCard
                  label="Pending"
                  value={billing.creditsBreakdown.pendingPaymentsFormatted}
                  sub="In review"
                  icon={<Clock />}
                  glow="primary"
                  tone="primary"
                  index={1}
                />
                <KpiCard
                  label="Meals"
                  value={String(billing.myMealsCount)}
                  sub={billing.period.monthLabel}
                  icon={<Utensils />}
                  glow="success"
                  tone="success"
                  index={2}
                />
              </>
            ) : activeBill ? (
              <>
                <KpiCard
                  label={activeBill.status === "PAID" ? "Settled" : "Due"}
                  value={formatMinor(activeBill.totalDueMinor > 0 ? activeBill.totalDueMinor : activeBill.subtotalMinor)}
                  sub={activeBill.status === "PAID" ? "Paid in full" : activeBill.status === "OVERDUE" ? "Past due" : "Amount due"}
                  icon={<Wallet />}
                  glow={activeBill.status === "PAID" ? "success" : activeBill.status === "OVERDUE" ? "danger" : "warning"}
                  tone={activeBill.status === "PAID" ? "success" : activeBill.status === "OVERDUE" ? "danger" : "warning"}
                  index={0}
                />
                <KpiCard
                  label="Status"
                  value={activeBill.status === "PAID" ? "Paid" : activeBill.status === "OVERDUE" ? "Overdue" : "Due"}
                  sub={activeBill.dueDate ? `Due ${formatDateInTz(activeBill.dueDate, tz)}` : "Finalized"}
                  icon={<Receipt />}
                  glow={activeBill.status === "PAID" ? "success" : activeBill.status === "OVERDUE" ? "danger" : "primary"}
                  tone={activeBill.status === "PAID" ? "success" : activeBill.status === "OVERDUE" ? "danger" : "primary"}
                  index={1}
                />
                <KpiCard
                  label="Meals"
                  value={String(activeBill.residentMealCount)}
                  sub={activeBill.guestMealCount > 0 ? `+ ${activeBill.guestMealCount} guest${activeBill.guestMealCount === 1 ? "" : "s"}` : "Consumed"}
                  icon={<Utensils />}
                  glow="success"
                  tone="success"
                  index={2}
                />
              </>
            ) : (
              <>
                <KpiCard
                  label="Due"
                  value="₹0.00"
                  sub="No bill"
                  icon={<Wallet />}
                  glow="neutral"
                  tone="neutral"
                  index={0}
                />
                <KpiCard
                  label="Status"
                  value="—"
                  sub="Not billed"
                  icon={<Receipt />}
                  glow="neutral"
                  tone="neutral"
                  index={1}
                />
                <KpiCard
                  label="Meals"
                  value="0"
                  sub={monthLongName(activeMonthKey)}
                  icon={<Utensils />}
                  glow="neutral"
                  tone="neutral"
                  index={2}
                />
              </>
            )}
          </div>
        </StaggerItem>

        {/* Primary action bar — positioned after KPIs matching payments.tsx */}
        {((isThisMonth && payableBills.length > 0) || (!isThisMonth && activePayableBill)) && (
          <StaggerItem>
            <div className="flex justify-center">
              <GlassButton
                variant="primary"
                icon={<Wallet />}
                onClick={() => {
                  setPayPreset(!isThisMonth && activePayableBill ? activePayableBill.id : null);
                  setPayOpen(true);
                }}
              >
                Pay Bill
              </GlassButton>
            </div>
          </StaggerItem>
        )}

        {/* Selected Month Bill view when a past month is picked */}
        {!isThisMonth && (
          activeBill ? (
            <StaggerItem>
              <GlassCard className="p-4" aria-label={`${monthLabel(activeBill.period.year, activeBill.period.month)} bill`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <Receipt className="size-5" aria-hidden />
                  </span>
                  <div>
                    <h3 className="font-semibold">{monthLabel(activeBill.period.year, activeBill.period.month)} Bill</h3>
                    <p className="kpi-num text-[11px] text-muted-foreground">
                      {activeBill.billNumber} · generated {formatDateInTz(activeBill.generatedAt, tz)}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <StatusBadge status={activeBill.status} />
                    {activeBill.dueDate && (
                      <span className="kpi-num text-xs text-muted-foreground hidden sm:inline">
                        Due {formatDateInTz(activeBill.dueDate, tz)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="glass-inset rounded-md p-3.5 my-3">
                  <BillLines bill={activeBill} />
                </div>

                {/* Expandable calculation explanation */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowActiveBillCalc((s) => !s)}
                    aria-expanded={showActiveBillCalc}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-2 text-[13px] font-medium text-primary transition-colors hover:text-primary/80"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Info className="size-3.5" aria-hidden />
                      How this was calculated
                    </span>
                    <ChevronDown
                      className={cn("size-4 transition-transform", showActiveBillCalc && "rotate-180")}
                      aria-hidden
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {showActiveBillCalc && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.22 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-1">
                          <CalculationExplanation bill={activeBill} />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Row actions */}
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border/20 pt-3">
                  <GlassButton
                    size="sm"
                    variant="secondary"
                    onClick={() => setDetailBillId(activeBill.id)}
                  >
                    View full sheet
                  </GlassButton>
                  {activeBill.totalDueMinor > 0 && activeBill.status !== "PAID" && (
                    <GlassButton
                      size="sm"
                      icon={<Wallet />}
                      onClick={() => {
                        setPayPreset(activeBill.id);
                        setPayOpen(true);
                      }}
                    >
                      Pay Bill
                    </GlassButton>
                  )}
                </div>
              </GlassCard>
            </StaggerItem>
          ) : (
            <StaggerItem>
              <EmptyState
                icon={FileSpreadsheet}
                title={`No bill for ${monthLongName(activeMonthKey)} ${activeYear}`}
                description="No bill was generated for this period."
                action={
                  <GlassButton variant="secondary" onClick={() => setMonthParam(undefined)}>
                    Return to current month
                  </GlassButton>
                }
              />
            </StaggerItem>
          )
        )}

        {/* Amount to pay — shown for current month (meals-page anatomy): Wallet icon
            header + compact orb rows with right-aligned money + row actions */}
        {isThisMonth && (
          <StaggerItem>
            <GlassCard className="p-4" aria-label="Amount to pay">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <Wallet className="size-5" aria-hidden />
                </span>
                <h3 className="font-semibold">Amount to Pay</h3>
                {unsettled.length > 0 && (
                  <span className="kpi-num text-xs text-muted-foreground">
                    · {unsettled.length} bill{unsettled.length === 1 ? "" : "s"}
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">Unsettled bills</span>
              </div>

              {unsettled.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  title="You're all settled"
                  description="No unpaid bills right now."
                />
              ) : (
                <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  {unsettled.map((bill) => (
                    <GlassCard key={bill.id} className="p-3">
                      <div className="flex items-start gap-3">
                        <MealOrb icon={<Wallet />} colorToken="amber" size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold">
                              {monthLabel(bill.period.year, bill.period.month)} bill
                            </p>
                            <StatusBadge status={bill.status} />
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span className="kpi-num inline-flex items-center gap-1">
                              <ArrowUpRight className="size-3" aria-hidden />
                              {bill.billNumber}
                            </span>
                            {bill.dueDate && (
                              <span className="kpi-num inline-flex items-center gap-1">
                                <CalendarClock className="size-3" aria-hidden />
                                Due {formatDateInTz(bill.dueDate, tz)}
                              </span>
                            )}
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                            {bill.residentMealCount} resident meals + {bill.guestMealCount} guest meals, minus
                            payments already counted. Submit a payment and the admin will verify it.
                          </p>
                        </div>

                        {/* Amount block — right-aligned (BoardOps money emphasis) */}
                        <div className="flex shrink-0 flex-col items-end gap-0.5">
                          <Money minor={bill.totalDueMinor} className="text-base font-bold" />
                          <span className="kpi-num text-[10px] text-muted-foreground">to pay</span>
                        </div>
                      </div>

                      {/* Row actions — pay this bill / open the calculation */}
                      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
                        <GlassButton
                          size="sm"
                          variant="secondary"
                          onClick={() => setDetailBillId(bill.id)}
                        >
                          View calculation
                        </GlassButton>
                        <GlassButton
                          size="sm"
                          onClick={() => {
                            setPayPreset(bill.id);
                            setPayOpen(true);
                          }}
                        >
                          Pay Bill
                        </GlassButton>
                      </div>
                    </GlassCard>
                  ))}
                </div>
              )}
            </GlassCard>
          </StaggerItem>
        )}

        {/* Current period running estimate — shown for current month */}
        {isThisMonth && (
          <StaggerItem>
            <section aria-labelledby="billing-estimate">
              <GlassCard className="p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <CalendarClock className="size-5" aria-hidden />
                  </span>
                  <h3 id="billing-estimate" className="font-semibold">
                    This month so far — {billing.period.monthLabel}
                  </h3>
                  <span className="ml-auto text-xs text-muted-foreground">Running estimate · updates as you eat</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <StatusBadge status={billing.period.status} />
                </div>
                <div className="mt-3">
                  <DataRow label="My meals this month" value={String(billing.myMealsCount)} />
                  <DataRow label="Guest meals" value={String(billing.myGuestCount)} />
                  <DataRow
                    label="Guest meals charge (estimate)"
                    value={billing.myGuestCount > 0 ? <Money minor={guestEstimateMinor} /> : "—"}
                  />
                  <DataRow
                    label="Meal charge per meal"
                    value={
                      isMoneyUsable(billing.mealChargeFormatted) ? (
                        <Money minor={billingDivSafe(billing.mealChargeFormatted)} />
                      ) : (
                        "—"
                      )
                    }
                  />
                  <DataRow label="Payments waiting for approval" value={<Money minor={billing.creditsBreakdown.pendingPaymentsMinor} />} />
                  <DataRow
                    label="Amount to Pay (all unsettled bills)"
                    value={<Money minor={billing.currentAmountToPayMinor} />}
                    strong
                    emphasized
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setShowEstimateCalc((s) => !s)}
                  aria-expanded={showEstimateCalc}
                  className="mt-3 flex w-full items-center justify-between gap-2 rounded-md px-1 py-2 text-[13px] font-medium text-primary transition-colors hover:text-primary/80"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Info className="size-3.5" aria-hidden />
                    How the estimate works
                  </span>
                  <ChevronDown
                    className={cn("size-4 transition-transform", showEstimateCalc && "rotate-180")}
                    aria-hidden
                  />
                </button>
                <AnimatePresence initial={false}>
                  {showEstimateCalc && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.22 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-1">
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Your meals are charged at a per-meal price set by the house formula at month end —
                          {billing.mealChargeSource ? (
                            <>
                              {" "}
                              currently{" "}
                              <span className="font-medium text-foreground/80">
                                {billing.mealChargeSource.humanPreview}
                              </span>
                              . Guest meals are charged at the fixed guest price{" "}
                              <span className="kpi-num">{formatMinor(billing.guestPriceMinor)}</span> each.
                            </>
                          ) : (
                            " guest meals use the fixed guest price."
                          )}{" "}
                          The estimate is a guide; the final bill is fixed when the month closes.
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </GlassCard>
            </section>
          </StaggerItem>
        )}

        {/* Bill history — ONE section card (FileSpreadsheet icon header, compact
            orb rows, right-aligned Due money); detail sheet opens on row tap */}
        <StaggerItem>
          <section aria-labelledby="billing-history">
            <GlassCard className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <FileSpreadsheet className="size-5" aria-hidden />
                </span>
                <h3 id="billing-history" className="font-semibold">{isThisMonth ? "Bills" : "All Bills"}</h3>
                <span className="kpi-num text-xs text-muted-foreground">· {bills.length}</span>
                <span className="ml-auto text-xs text-muted-foreground">Tap a bill for its calculation</span>
              </div>

              {billsQuery.isPending ? (
                <ListSkeleton rows={3} />
              ) : billsQuery.isError ? (
                <ErrorState
                  code={billsQuery.error?.code}
                  message={billsQuery.error?.message}
                  onRetry={() => void billsQuery.refetch()}
                />
              ) : bills.length === 0 ? (
                <EmptyState
                  icon={FileSpreadsheet}
                  title="No bills yet"
                  description="Your first bill will appear here after the month closes."
                />
              ) : (
                <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  {sortedBills.map((bill, i) => (
                    <motion.div
                      key={bill.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...SPRING_SNAPPY, delay: Math.min(i * 0.04, 0.2) }}
                    >
                      <GlassCard
                        interactive
                        onClick={() => {
                          setMonthParam(`${bill.period.year}-${String(bill.period.month).padStart(2, "0")}`);
                          setDetailBillId(bill.id);
                        }}
                        className={cn(
                          "p-3 transition-all",
                          bill.id === activeBill?.id && "ring-1 ring-primary/40 bg-primary/[0.04]"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <MealOrb icon={<FileSpreadsheet />} colorToken="frost" size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-semibold">
                                {monthLabel(bill.period.year, bill.period.month)}
                              </p>
                              <StatusBadge status={bill.status} />
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                              <span className="kpi-num inline-flex items-center gap-1">
                                <ArrowUpRight className="size-3" aria-hidden />
                                {bill.billNumber}
                              </span>
                              {bill.dueDate && (
                                <span className="kpi-num inline-flex items-center gap-1">
                                  <CalendarDays className="size-3" aria-hidden />
                                  due {formatDateInTz(bill.dueDate, tz)}
                                </span>
                              )}
                              <span className="kpi-num">
                                {bill.residentMealCount} meals · total {formatMinor(bill.subtotalMinor)}
                              </span>
                            </div>
                          </div>

                          {/* Amount block — right-aligned (BoardOps money emphasis) */}
                          <div className="flex shrink-0 flex-col items-end gap-0.5">
                            <Money minor={bill.totalDueMinor} className="text-base font-bold" />
                            <span className="kpi-num text-[10px] text-muted-foreground">due</span>
                          </div>
                        </div>
                      </GlassCard>
                    </motion.div>
                  ))}
                </div>
              )}
            </GlassCard>
          </section>
        </StaggerItem>
      </StaggerGroup>

      <BillDetailSheet
        billId={detailBillId}
        onOpenChange={(open) => {
          if (!open) setDetailBillId(null);
        }}
        onPay={(bill) => {
          setDetailBillId(null);
          setPayPreset(bill.id);
          setPayOpen(true);
        }}
        tz={tz}
      />

      <SubmitPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        bills={payableBills}
        presetBillId={payPreset}
      />
    </>
  );
}

/** Parse a formatted "₹48.71" string back to minor (for NaN-guarded values). */
function billingDivSafe(formatted: string): number {
  const cleaned = formatted.replace(/[₹,\s−]/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}
