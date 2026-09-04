"use client";

/**
 * Admin Funds — BoardOps funds-view composition: tone/glow KPIs, client-side
 * search + All/Deficit filter pills, per-resident fund rows with gradient
 * avatars (deterministic per name) and transaction strips, the ledger
 * account balances and active policy exemptions.
 * GET /api/v1/admin/funds · POST /policy-exemptions/:id/cancel
 */

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Banknote, Calendar, ChevronRight, DoorOpen, Landmark, RotateCcw, ShieldOff, TrendingDown, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { KpiGridSkeleton, ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import SectionHeading from "@/components/glass/SectionHeading";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { navigateTo } from "@/hooks/use-hash-route";
import { ApiClientError } from "@/lib/api";
import { gradientForName, initialsOf } from "@/lib/gradients";
import { cn } from "@/lib/utils";
import { errMessage, useInvalidate } from "./_shared/api";
import { SearchField } from "./_shared/fields";
import { Chip, FilterChips, KpiGrid } from "./_shared/chrome";
import { RefundDialog } from "./_shared/refund-dialog";
import { fmtDate, monthLabel, todayKey } from "./_shared/format";
import type { FundsSummary, PolicyExemptionRow } from "./_shared/types";

const FUNDS_PATH = "/api/v1/admin/funds";

interface FundsData {
  residents: (FundsSummary & {
    fullName: string;
    roomNumber: string | null;
    email: string;
    creditsFormatted: string;
    pendingPaymentsFormatted: string;
    chargesFormatted: string;
    availableFormatted: string;
    amountToPayFormatted: string;
    deficitFormatted: string;
  })[];
  kpis: {
    month?: string;
    depositsThisMonth: number;
    depositsThisMonthFormatted: string;
    availableFundsTotal: number;
    availableFundsTotalFormatted: string;
    totalDeficit: number;
    totalDeficitFormatted: string;
    residentCount: number;
  };
  accounts: {
    code: string;
    name: string;
    type: string;
    debitMinor: number;
    creditMinor: number;
    balanceMinor: number;
    balanceFormatted: string;
  }[];
  policyExemptions: PolicyExemptionRow[];
}

type FundFilter = "ALL" | "DEFICIT";

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

export default function AdminFunds() {
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const { data, isLoading, error, refetch } = useApiQuery<FundsData>(FUNDS_PATH, {
    month: monthParam,
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FundFilter>("DEFICIT");
  const [cancelTarget, setCancelTarget] = useState<PolicyExemptionRow | null>(null);
  const [refundTarget, setRefundTarget] = useState<FundsData["residents"][0] | null>(null);
  const [acting, setActing] = useState(false);
  const invalidate = useInvalidate();

  const thisMonthKey = todayKey().slice(0, 7);
  const activeMonthKey = data?.kpis?.month ?? monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;

  /* Client-side search + deficit filter over the fetched summaries (funds-view
     pattern). Memoised before the early returns so hook order is stable. */
  const residents = data?.residents ?? [];
  const searchedResidents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return residents;
    return residents.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        (r.roomNumber ?? "").toLowerCase().includes(q)
    );
  }, [residents, search]);

  const deficitCount = useMemo(
    () => searchedResidents.filter((r) => r.deficitMinor > 0).length,
    [searchedResidents]
  );

  const visibleResidents = useMemo(() => {
    const list = filter === "DEFICIT" ? searchedResidents.filter((r) => r.deficitMinor > 0) : searchedResidents;
    return [...list].sort((a, b) => {
      const rA = a.deficitMinor > 0 ? 0 : 1;
      const rB = b.deficitMinor > 0 ? 0 : 1;
      if (rA !== rB) return rA - rB;
      if (rA === 0) return b.deficitMinor - a.deficitMinor; // Largest deficit first
      return a.availableMinor - b.availableMinor; // Lowest balance first
    });
  }, [searchedResidents, filter]);

  async function cancelExemption(reason: string | undefined) {
    if (!cancelTarget) return;
    setActing(true);
    try {
      await postJson(`/api/v1/admin/policy-exemptions/${cancelTarget.id}/cancel`, { reason });
      invalidate([FUNDS_PATH]);
      toast.success("Exemption cancelled", { description: cancelTarget.residentName ?? "Resident" });
      setCancelTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <KpiGridSkeleton count={3} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (error || !data) {
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

  const deficitResidents = residents.filter((r) => r.deficitMinor > 0);

  const chips = [
    { value: "DEFICIT", label: "Deficit", count: deficitCount },
    { value: "ALL", label: "All", count: searchedResidents.length },
  ];

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
        kpis={[
          {
            label: "Deposits",
            value: data.kpis.depositsThisMonthFormatted,
            icon: <Wallet />,
            sub: "Verified",
            tone: "success",
            glow: "success",
          },
          {
            label: "Available",
            value: data.kpis.availableFundsTotalFormatted,
            icon: <Banknote />,
            sub: `${data.kpis.residentCount} residents`,
            tone: "primary",
            glow: "primary",
          },
          {
            label: "Deficit",
            value: data.kpis.totalDeficitFormatted,
            icon: <TrendingDown />,
            sub: `${deficitResidents.length} below min`,
            tone: "warning",
            glow: "warning",
          },
        ]}
      />
      </StaggerItem>

      <StaggerItem>
      {/* resident funds — outer card like payments */}
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Wallet className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">Per-resident funds</h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search by name, room or email…" />
          <FilterChips chips={chips} value={filter} onChange={(v) => setFilter(v as FundFilter)} layoutId="admin-funds-chips" />
        </div>
        {residents.length === 0 ? (
          <EmptyState icon={Wallet} title="No active residents" description="Funds appear once residents are approved and payments flow." />
        ) : visibleResidents.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={search ? "No residents match" : "No residents with deficit"}
            description={search ? "Try a different name, room or email." : "Nobody is below their balance threshold right now."}
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {visibleResidents.map((r, i) => (
              <motion.div
                key={r.residentId}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
              >
                <GlassCard className="overflow-hidden rounded-2xl">
                  <div
                    className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                    onClick={() => navigateTo(`/admin/residents/${r.residentId}`)}
                  >
                  {/* Row 1: orb + name/room (left) | available balance (right) — fixed h-10 */}
                  <div className="flex h-10 items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <MealOrb icon={<Wallet />} colorToken={r.deficitMinor > 0 ? "amber" : "emerald"} size="sm" />
                      <div className="min-w-0">
                        <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                          {r.fullName}
                        </h4>
                        <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                          <DoorOpen className="size-3 shrink-0" aria-hidden />
                          {r.roomNumber ? `Room ${r.roomNumber}` : r.email}
                        </p>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <Money minor={r.availableMinor} className={cn("text-base font-bold block leading-tight", r.availableMinor < 0 ? "text-danger" : "text-success")} />
                      <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                        available
                      </span>
                    </div>
                  </div>

                  {/* Row 2: chips (left) | Details pill (right) — fixed h-7 */}
                  <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                    <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                      <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                        Deposit <Money minor={r.creditsMinor} plain className="font-semibold text-success" />
                      </span>
                      <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                        Used <Money minor={r.chargesMinor} plain className="font-semibold" />
                      </span>
                      {r.deficitMinor > 0 && (
                        <span className="kpi-num text-[11px] text-warning font-semibold shrink-0">
                          Deficit <Money minor={r.deficitMinor} plain className="font-bold" />
                        </span>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {r.availableMinor > 0 && (
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRefundTarget(r);
                          }}
                          aria-label={`Issue refund for ${r.fullName}`}
                          className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-primary transition-all hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          <span>Refund</span>
                        </motion.button>
                      )}

                      {/* Details pill */}
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.94 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateTo(`/admin/residents/${r.residentId}`);
                        }}
                        aria-label={`View details for ${r.fullName}`}
                        className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <span>Details</span>
                        <ChevronRight className="size-3" aria-hidden />
                      </motion.button>
                    </div>
                  </div>
                </div>
              </GlassCard>
            </motion.div>
            ))}
          </div>
        )}
      </GlassCard>
      </StaggerItem>


      <StaggerItem>
      {/* exemptions */}
      <section className="space-y-3">
        <SectionHeading>Active exemptions</SectionHeading>
        {data.policyExemptions.length === 0 ? (
          <EmptyState
            icon={ShieldOff}
            title="No active exemptions"
            description="Create one from a resident's Funds tab to temporarily lift deficit restrictions."
          />
        ) : (
          <div className="space-y-2">
            {data.policyExemptions.map((ex) => (
              <GlassCard key={ex.id} className="flex flex-wrap items-center gap-3 p-4">
                <span
                  aria-hidden
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]",
                    "bg-gradient-to-br",
                    gradientForName(ex.residentName ?? "Resident")
                  )}
                >
                  {initialsOf(ex.residentName ?? "Resident")}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{ex.residentName ?? "Resident"}</p>
                    <Chip tone="warning">Deficit exemption</Chip>
                  </div>
                  <p className="mt-1 truncate text-[12px] text-muted-foreground">{ex.reason}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/80">
                    {ex.expiresAt ? `Until ${fmtDate(ex.expiresAt)}` : "Until cancelled"} · granted {fmtDate(ex.createdAt)}
                  </p>
                </div>
                <GlassButton variant="destructive" size="sm" onClick={() => setCancelTarget(ex)}>
                  Cancel…
                </GlassButton>
              </GlassCard>
            ))}
          </div>
        )}
      </section>
      </StaggerItem>

      {cancelTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setCancelTarget(null)}
          title="Cancel exemption"
          description={
            <>
              Deficit restrictions apply to this resident again immediately — meals may become unavailable until the
              balance recovers.
              <span className="mt-2 block font-medium">{cancelTarget.residentName ?? "Resident"}</span>
            </>
          }
          confirmLabel="Cancel exemption"
          tone="destructive"
          requireReason
          loading={acting}
          onConfirm={(reason) => void cancelExemption(reason)}
        />
      )}

      {refundTarget && (
        <RefundDialog
          open={Boolean(refundTarget)}
          onOpenChange={(open) => !open && setRefundTarget(null)}
          residentId={refundTarget.residentId}
          residentName={refundTarget.fullName}
          availableMinor={refundTarget.availableMinor}
          onSaved={() => invalidate([FUNDS_PATH, "/api/v1/admin/payments", "/api/v1/admin/dashboard"])}
        />
      )}
    </StaggerGroup>
  );
}
