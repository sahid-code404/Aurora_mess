"use client";

/**
 * Resident 360° — one resident, every dimension.
 * GET /api/v1/admin/residents/:id (+ meals today, lifecycle actions,
 * membership edit, deficit-policy exemption).
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  BookUser,
  CalendarPlus,
  ClipboardList,
  Clock,
  History,
  Landmark,
  Pencil,
  ReceiptText,
  RotateCcw,
  ShieldPlus,
  Smartphone,
  UserRound,
  Utensils,
  Wallet,
  Wallet2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import TabRow from "@/components/glass/TabRow";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson, patchJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { goBack, navigateTo } from "@/hooks/use-hash-route";
import { ApiClientError } from "@/lib/api";
import { gradientForName, initialsOf } from "@/lib/gradients";
import { cn } from "@/lib/utils";
import { errMessage, useInvalidate } from "./_shared/api";
import { Chip, DetailDialog, KpiGrid } from "./_shared/chrome";
import { TextField } from "./_shared/fields";
import { fmtDate, fmtDateTime, fmtMinor, timeAgo } from "./_shared/format";
import type { Resident360 } from "./_shared/types";

interface TodayMealRow {
  residentId: string;
  fullName: string;
  roomNumber: string | null;
  monthlyMealCount: number;
  today: {
    mealInstanceId: string;
    residentMealId: string;
    name: string;
    effectiveState: string;
    effectiveReason: string;
    baselineState: string;
    adminOverrideState: string | null;
    overridden: boolean;
    locked: boolean;
    version: number;
  }[];
}

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "meals", label: "Meals" },
  { key: "funds", label: "Funds" },
  { key: "payments", label: "Payments" },
  { key: "bills", label: "Bills" },
  { key: "tasks", label: "Tasks" },
  { key: "activity", label: "Activity" },
];

type ConfirmKind = "approve" | "request-changes" | "reject" | "deactivate" | "activate" | null;

/** Method orbs for payment rows (mirrors the admin payments METHOD_META). */
const METHOD_ORB: Record<string, { icon: LucideIcon; orb: string }> = {
  UPI: { icon: Smartphone, orb: "frost" },
  CASH: { icon: Banknote, orb: "emerald" },
  BANK_TRANSFER: { icon: Landmark, orb: "amber" },
};

const CONFIRM_META: Record<
  Exclude<ConfirmKind, null>,
  { title: string; description: string; confirm: string; requireReason: boolean; toast: string; destructive?: boolean }
> = {
  approve: { title: "Approve resident", description: "They will be able to sign in and opt into meals.", confirm: "Approve", requireReason: false, toast: "Resident approved" },
  "request-changes": { title: "Request changes", description: "The resident will be asked to update their details.", confirm: "Request changes", requireReason: true, toast: "Changes requested" },
  reject: { title: "Reject application", description: "The application closes and sign-in is blocked.", confirm: "Reject", requireReason: true, toast: "Application rejected", destructive: true },
  deactivate: { title: "Deactivate resident", description: "Sessions are revoked and meals stop. History is preserved.", confirm: "Deactivate", requireReason: true, toast: "Resident deactivated", destructive: true },
  activate: { title: "Reactivate resident", description: "They can sign in and opt into meals again.", confirm: "Reactivate", requireReason: false, toast: "Resident reactivated" },
};

export default function AdminResident360({ id }: { id?: string }) {
  const [tab, setTab] = useState("overview");
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [acting, setActing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [exemptionOpen, setExemptionOpen] = useState(false);
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  const { data, isLoading, error, refetch } = useApiQuery<Resident360>(id ? `/api/v1/admin/residents/${id}` : null);
  const mealsQuery = useApiQuery<{ residents: TodayMealRow[] }>(id && tab === "meals" ? "/api/v1/admin/meals" : null);

  const todayRow = useMemo(
    () => (mealsQuery.data?.residents ?? []).find((r) => r.residentId === id) ?? null,
    [mealsQuery.data, id]
  );

  if (!id) {
    return <EmptyState icon={UserRound} title="No resident selected" description="Go back to the residents list and pick one." />;
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={(error as ApiClientError | undefined)?.code}
          message={(error as ApiClientError | undefined)?.message ?? "This resident could not be found."}
          onRetry={() => void refetch()}
        />
        <div className="flex justify-center">
          <GlassButton variant="secondary" icon={<ArrowLeft />} onClick={() => goBack("#/admin/residents")}>
            Back to residents
          </GlassButton>
        </div>
      </div>
    );
  }

  const { user, profile, statusHistory, funds, payments, bills, tasks } = data;

  async function runLifecycle(kind: Exclude<ConfirmKind, null>, reason?: string) {
    if (!id) return;
    setActing(true);
    try {
      const needsBody = kind !== "approve" && kind !== "activate";
      await postJson(`/api/v1/admin/residents/${id}/${kind}`, needsBody ? { reason } : {});
      invalidate([`/api/v1/admin/residents/${id}`, "/api/v1/admin/residents", "/api/v1/admin/dashboard"]);
      toast.success(CONFIRM_META[kind].toast, { description: profile.fullName });
      setConfirm(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  const isPendingish = user.status === "PENDING_APPROVAL" || user.status === "CHANGES_REQUESTED";

  return (
    <StaggerGroup className="space-y-4">
      {/* -------------------- Compact Profile Hero Card -------------------- */}
      <StaggerItem>
      <GlassCard className="p-4 sm:p-5">
        <div className="flex flex-col gap-3">
          {/* Top row: Back button, Avatar, Identity info & Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => goBack("#/admin/residents")}
                aria-label="Back to residents"
                className="glass-inset hover:glass flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-2xl text-muted-foreground transition-all hover:text-foreground"
              >
                <ArrowLeft className="size-4" aria-hidden />
              </button>

              <span
                aria-hidden
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-base font-bold text-white shadow-sm ring-1 ring-white/20",
                  gradientForName(profile.fullName)
                )}
              >
                {initialsOf(profile.fullName)}
              </span>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-base sm:text-lg font-bold tracking-tight text-foreground">
                    {profile.fullName}
                  </h1>
                  <StatusBadge status={user.status} />
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {user.email}
                </p>
              </div>
            </div>

            {/* Actions: Compact pill buttons */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {isPendingish && (
                <>
                  <GlassButton variant="primary" size="sm" icon={<BadgeCheck />} onClick={() => setConfirm("approve")}>
                    Approve
                  </GlassButton>
                  <GlassButton variant="secondary" size="sm" onClick={() => setConfirm("request-changes")}>
                    Request changes
                  </GlassButton>
                  <GlassButton variant="destructive" size="sm" onClick={() => setConfirm("reject")}>
                    Reject
                  </GlassButton>
                </>
              )}
              {user.status === "ACTIVE" && (
                <GlassButton variant="destructive" size="sm" onClick={() => setConfirm("deactivate")}>
                  Deactivate
                </GlassButton>
              )}
              {user.status === "INACTIVE" && (
                <GlassButton variant="primary" size="sm" onClick={() => setConfirm("activate")}>
                  Reactivate
                </GlassButton>
              )}
              {funds && bills.length > 0 && funds.availableMinor > 0 && (
                <GlassButton
                  variant="primary"
                  size="sm"
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={() => navigateTo("/admin/payments/refunds")}
                >
                  Refund Center
                </GlassButton>
              )}
              <GlassButton variant="secondary" size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditOpen(true)}>
                Edit resident
              </GlassButton>
            </div>
          </div>

          {/* Quick metadata strip */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border/15 pt-2.5 text-xs text-muted-foreground">
            <span className="glass-inset inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-foreground">
              {profile.roomNumber ? `Room ${profile.roomNumber}` : "No room"}
            </span>
            {profile.phone && (
              <span className="glass-inset inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-foreground">
                <Smartphone className="size-3 text-muted-foreground" aria-hidden />
                {profile.phone}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto">
              Joined {fmtDate(user.createdAt)}
            </span>
          </div>
        </div>
      </GlassCard>
      </StaggerItem>

      {/* --------------------------- 3-KPI Grid --------------------------- */}
      <StaggerItem>
      <KpiGrid
        kpis={[
          {
            label: "Available",
            value: funds ? fmtMinor(funds.availableMinor) : "—",
            icon: <Wallet />,
            tone: "success",
            glow: "success",
            sub: "Spendable balance",
          },
          {
            label: "Due",
            value: funds ? fmtMinor(funds.amountToPayMinor) : "—",
            icon: <ReceiptText />,
            tone: funds && funds.amountToPayMinor > 0 ? "danger" : "primary",
            glow: funds && funds.amountToPayMinor > 0 ? "danger" : "primary",
            sub: funds && funds.amountToPayMinor > 0 ? "Payment required" : "Zero dues",
          },
          {
            label: "Pending",
            value: funds ? fmtMinor(funds.pendingPaymentsMinor) : "—",
            icon: <Wallet />,
            tone: "warning",
            glow: "warning",
            sub: "In review",
          },
        ]}
      />
      </StaggerItem>

      {/* ----------------------------- Tab Row ---------------------------- */}
      <StaggerItem>
      <TabRow tabs={TABS} activeKey={tab} onChange={setTab} layoutId="admin-resident360-tabs" />
      </StaggerItem>

      {/* ---------------------------- Overview Tab --------------------------- */}
      <StaggerItem>
      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Membership & Profile Info */}
            <GlassCard className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <BookUser className="size-5" aria-hidden />
                </span>
                <h3 className="font-semibold text-base">Membership & Details</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="glass-inset rounded-2xl p-2.5 px-3">
                  <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Member Period</span>
                  <span className="font-semibold text-foreground mt-0.5 block truncate">
                    {user.membershipEffectiveFrom ? fmtDate(user.membershipEffectiveFrom) : "—"} → {user.membershipEffectiveUntil ? fmtDate(user.membershipEffectiveUntil) : "Open-ended"}
                  </span>
                </div>
                <div className="glass-inset rounded-2xl p-2.5 px-3">
                  <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Room Assignment</span>
                  <span className="font-semibold text-foreground mt-0.5 block truncate">
                    {profile.roomNumber ? `Room ${profile.roomNumber}` : "No room assigned"}
                  </span>
                </div>
                <div className="glass-inset rounded-2xl p-2.5 px-3">
                  <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Email Address</span>
                  <span className="font-semibold text-foreground mt-0.5 block truncate" title={user.email}>
                    {user.email}
                  </span>
                </div>
                <div className="glass-inset rounded-2xl p-2.5 px-3">
                  <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Phone Number</span>
                  <span className="font-semibold text-foreground mt-0.5 block truncate">
                    {profile.phone ?? "Not provided"}
                  </span>
                </div>
              </div>
            </GlassCard>

            {/* Funds Summary */}
            <GlassCard className="p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <Wallet className="size-5" aria-hidden />
                  </span>
                  <h3 className="font-semibold text-base">Funds Summary</h3>
                </div>
                {funds && <StatusBadge status={funds.policyState} />}
              </div>

              {funds ? (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="glass-inset rounded-2xl p-2.5 px-3">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Deposited</span>
                      <Money minor={funds.creditsMinor} className="font-bold text-sm text-foreground mt-0.5 block" />
                    </div>
                    <div className="glass-inset rounded-2xl p-2.5 px-3">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Consumed</span>
                      <Money minor={funds.chargesMinor} className="font-bold text-sm text-foreground mt-0.5 block" />
                    </div>
                    <div className="glass-inset rounded-2xl p-2.5 px-3">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">Available</span>
                      <Money minor={funds.availableMinor} className="font-bold text-sm text-success mt-0.5 block" />
                    </div>
                    <div className="glass-inset rounded-2xl p-2.5 px-3">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">In Review</span>
                      <Money minor={funds.pendingPaymentsMinor} className="font-bold text-sm text-warning mt-0.5 block" />
                    </div>
                  </div>

                  {(funds.deficitMinor > 0 || funds.graceUntilIso) && (
                    <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/15">
                      {funds.deficitMinor > 0 && (
                        <Chip tone="warning">Amount to pay <Money minor={funds.amountToPayMinor} plain /></Chip>
                      )}
                      {funds.graceUntilIso && (
                        <Chip tone="warning">Grace until {fmtDate(funds.graceUntilIso)}</Chip>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Funds are tracked once the resident is active.</p>
              )}
            </GlassCard>
          </div>

          {/* Status History */}
          <GlassCard className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <History className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold text-base">Status History</h3>
            </div>

            {statusHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">No status changes recorded yet.</p>
            ) : (
              <div className="space-y-2">
                {statusHistory.map((h) => (
                  <div
                    key={h.id}
                    className="glass-inset border border-border/40 flex items-center gap-3 rounded-full p-2 px-3.5"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <History className="size-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-foreground">
                        {h.fromStatus ? `${h.fromStatus} → ` : ""}{h.toStatus}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {h.reason ?? "No reason recorded"}
                      </p>
                    </div>
                    <span className="kpi-num shrink-0 text-[11px] text-muted-foreground">
                      {fmtDateTime(h.createdAt, tz)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        </div>
      )}
      </StaggerItem>

      {/* ----------------------------- Meals Tab ---------------------------- */}
      <StaggerItem>
      {tab === "meals" && (
        <GlassCard className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Utensils className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold text-base">Meals This Month</h3>
            </div>
            {todayRow && (
              <span className="glass-inset rounded-full px-2.5 py-0.5 text-xs font-semibold text-primary">
                {todayRow.monthlyMealCount} confirmed
              </span>
            )}
          </div>

          {mealsQuery.isLoading ? (
            <ListSkeleton rows={3} />
          ) : todayRow ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Today's Materialized Meals
              </p>
              <div className="space-y-2">
                {todayRow.today.map((m) => (
                  <div
                    key={m.mealInstanceId}
                    className="glass-inset border border-border/40 flex items-center justify-between gap-3 rounded-full p-2.5 px-3.5"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Utensils className="size-3.5" aria-hidden />
                      </span>
                      <span className="truncate text-xs sm:text-sm font-medium text-foreground">
                        {m.name}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {(m.overridden || m.effectiveReason === "ADMIN_OVERRIDE") && <Chip tone="warning">Override</Chip>}
                      {m.locked && <Chip tone="neutral">Locked</Chip>}
                      <StatusBadge status={m.effectiveState} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={Utensils}
              title="No meals for today"
              description="Active meals appear here once materialized by the system."
            />
          )}
        </GlassCard>
      )}
      </StaggerItem>

      {/* ----------------------------- Funds Tab ---------------------------- */}
      <StaggerItem>
      {tab === "funds" && (
        <GlassCard className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <ShieldPlus className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold text-base">Funds & Policy</h3>
            </div>
          </div>

          {funds ? (
            <>
              <GlassCard className="group p-3 sm:p-3.5 rounded-2xl transition-all hover:ring-1 hover:ring-primary/25">
              {/* Row 1 — Funds summary */}
              <div className="flex h-10 items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <MealOrb icon={<Wallet />} colorToken="emerald" size="sm" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <div className="flex items-baseline gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Deposits</span>
                        <Money minor={funds.creditsMinor} className="text-sm font-bold text-success" />
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Consumed</span>
                        <Money minor={funds.chargesMinor} className="text-sm font-bold" />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 mt-0.5">
                      <div className="flex items-baseline gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Available</span>
                        <Money minor={funds.availableMinor} className={cn("text-sm font-bold", funds.availableMinor < 0 ? "text-danger" : "text-primary")} />
                      </div>
                      {funds.deficitMinor > 0 && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Deficit</span>
                          <Money minor={funds.deficitMinor} className="text-sm font-bold text-warning" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {funds.amountToPayMinor > 0 && (
                  <div className="text-right shrink-0">
                    <Money minor={funds.amountToPayMinor} className="text-base font-bold text-warning block leading-tight" />
                    <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                      due
                    </span>
                  </div>
                )}
              </div>

              {/* Row 2 — Status chips + Actions */}
              <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                  <StatusBadge status={funds.policyState} />
                  <Chip tone="neutral">Threshold <Money minor={funds.thresholdMinor} plain /></Chip>
                  {funds.graceUntilIso && <Chip tone="warning">Grace {fmtDate(funds.graceUntilIso)}</Chip>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {bills.length > 0 && funds.availableMinor > 0 && (
                    <GlassButton
                      variant="primary"
                      size="sm"
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => navigateTo("/admin/payments/refunds")}
                      icon={<RotateCcw className="size-3" />}
                    >
                      Refund Center
                    </GlassButton>
                  )}
                  <GlassButton
                    variant="ghost"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setExemptionOpen(true)}
                  >
                    Exemption
                  </GlassButton>
                </div>
              </div>
            </GlassCard>

            {/* Refund History */}
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Refund History
                </h4>
                {bills.length > 0 && funds.availableMinor > 0 && (
                  <button
                    type="button"
                    onClick={() => navigateTo("/admin/payments/refunds")}
                    className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    <RotateCcw className="size-3" />
                    <span>Refund Center</span>
                  </button>
                )}
              </div>
              {(!data.refunds || data.refunds.length === 0) ? (
                <div className="glass-inset rounded-xl p-3.5 text-center text-xs text-muted-foreground">
                  No refunds or excess credit resolutions recorded for this resident.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {data.refunds.map((ref) => (
                    <GlassCard key={ref.id} className="p-3 rounded-xl flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-foreground">
                            {ref.mode === "ISSUE_REFUND" ? "Cash Payout" : "Carry Forward"}
                          </span>
                          <Chip tone={ref.mode === "ISSUE_REFUND" ? "warning" : "frost"}>
                            {ref.status}
                          </Chip>
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {ref.status === "VOIDED" ? `Corrected: ${ref.voidReason ?? "Administrative correction"}` : ref.reason}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {fmtDate(ref.createdAt)} {ref.destination ? `· ${ref.destination}` : ""}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <Money minor={ref.amountMinor} className="text-sm font-bold text-foreground" />
                      </div>
                    </GlassCard>
                  ))}
                </div>
              )}
            </div>
          </>
          ) : (
            <EmptyState icon={Wallet} title="No funds data" description="Funds appear once the resident is active." />
          )}
        </GlassCard>
      )}
      </StaggerItem>

      {/* --------------------------- Payments Tab --------------------------- */}
      <StaggerItem>
      {tab === "payments" && (
        <GlassCard className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Wallet className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold text-base">Payments</h3>
            </div>
            {payments.length > 0 && (
              <span className="kpi-num text-xs text-muted-foreground">
                {payments.length} recorded
              </span>
            )}
          </div>

          {payments.length === 0 ? (
            <EmptyState icon={Wallet} title="No payments yet" description="Submitted payments will appear here." />
          ) : (
            <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {payments.map((p, i) => {
                const methodMeta = METHOD_ORB[p.method] ?? { icon: Wallet2, orb: "sky" };
                const MethodIcon = methodMeta.icon;
                return (
                  <motion.div
                    key={p.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                  >
                    <GlassCard className="group p-3 sm:p-3.5 rounded-2xl transition-all hover:ring-1 hover:ring-primary/25">
                      <div className="flex h-10 items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <MealOrb icon={<MethodIcon />} colorToken={methodMeta.orb} size="sm" />
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                              {p.displayNumber} · {p.method}
                            </h4>
                            <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <Clock className="size-3 shrink-0" aria-hidden />
                              {fmtDateTime(p.submittedAt, tz)}
                            </p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <Money minor={p.amountMinor} className="text-base font-bold text-foreground block leading-tight" />
                          <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                            deposited
                          </span>
                        </div>
                      </div>

                      <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <StatusBadge status={p.status} />
                          {p.reference && (
                            <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[130px]" title={p.reference}>
                              Ref {p.reference}
                            </span>
                          )}
                        </div>
                      </div>
                    </GlassCard>
                  </motion.div>
                );
              })}
            </div>
          )}
        </GlassCard>
      )}
      </StaggerItem>

      {/* ----------------------------- Bills Tab ---------------------------- */}
      <StaggerItem>
      {tab === "bills" && (
        <GlassCard className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <ReceiptText className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold text-base">Bills</h3>
            </div>
            {bills.length > 0 && (
              <span className="kpi-num text-xs text-muted-foreground">
                {bills.length} generated
              </span>
            )}
          </div>

          {bills.length === 0 ? (
            <EmptyState icon={ReceiptText} title="No bills yet" description="Bills appear after each billing period is generated." />
          ) : (
            <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {bills.map((b, i) => (
                <motion.div
                  key={b.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                >
                  <GlassCard className="group p-3 sm:p-3.5 rounded-2xl transition-all hover:ring-1 hover:ring-primary/25">
                    <div className="flex h-10 items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MealOrb icon={<ReceiptText />} colorToken="frost" size="sm" />
                        <div className="min-w-0">
                          <h4 className="truncate text-sm font-semibold text-foreground tracking-tight">
                            {b.billNumber}
                          </h4>
                          <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                            <Clock className="size-3 shrink-0" aria-hidden />
                            {fmtDateTime(b.generatedAt, tz)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <Money minor={b.totalDueMinor} className="text-base font-bold text-foreground block leading-tight" />
                        <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                          total due
                        </span>
                      </div>
                    </div>

                    <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                      <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        <StatusBadge status={b.status} />
                        <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                          {b.lineCount} lines
                        </span>
                        <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                          · Due {fmtDate(b.dueDate)}
                        </span>
                      </div>
                    </div>
                  </GlassCard>
                </motion.div>
              ))}
            </div>
          )}
        </GlassCard>
      )}
      </StaggerItem>

      {/* ----------------------------- Tasks Tab ---------------------------- */}
      <StaggerItem>
      {tab === "tasks" && (
        <GlassCard className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <ClipboardList className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold text-base">Assigned Tasks</h3>
            </div>
            {tasks.length > 0 && (
              <span className="kpi-num text-xs text-muted-foreground">
                {tasks.length} assigned
              </span>
            )}
          </div>

          {tasks.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No tasks assigned" description="Assign a task from the Tasks page." />
          ) : (
            <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {tasks.map((t, i) => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}
                >
                  <GlassCard className="group p-3 sm:p-3.5 rounded-2xl transition-all hover:ring-1 hover:ring-primary/25">
                    <div className="flex h-10 items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MealOrb icon={<ClipboardList />} colorToken="sky" size="sm" />
                        <div className="min-w-0">
                          <h4 className="truncate text-sm font-semibold text-foreground tracking-tight" title={t.description}>
                            {t.description}
                          </h4>
                          <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                            <Clock className="size-3 shrink-0" aria-hidden />
                            {timeAgo(t.createdAt)}
                          </p>
                        </div>
                      </div>
                      {t.estimatedAmountMinor != null && (
                        <div className="text-right shrink-0">
                          <Money minor={t.estimatedAmountMinor} className="text-base font-bold text-foreground block leading-tight" />
                          <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                            estimate
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                      <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        <StatusBadge status={t.status} />
                        <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                          {t.dueDate ? `Due ${fmtDate(t.dueDate)}` : "No due date"}
                        </span>
                      </div>
                    </div>
                  </GlassCard>
                </motion.div>
              ))}
            </div>
          )}
        </GlassCard>
      )}
      </StaggerItem>

      {/* --------------------------- Activity Tab --------------------------- */}
      <StaggerItem>
      {tab === "activity" && (
        <GlassCard className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <History className="size-5" aria-hidden />
            </span>
            <h3 className="font-semibold text-base">Activity</h3>
          </div>

          {(data.audit as unknown[]).length === 0 ? (
            <EmptyState icon={History} title="No activity recorded" description="Audit events for this resident will appear here." />
          ) : (
            <p className="text-xs text-muted-foreground">See the full Audit Trail for details.</p>
          )}
        </GlassCard>
      )}
      </StaggerItem>

      {/* ------------------------------ Dialogs ------------------------------ */}
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={CONFIRM_META[confirm].title}
          description={CONFIRM_META[confirm].description}
          confirmLabel={CONFIRM_META[confirm].confirm}
          tone={CONFIRM_META[confirm].destructive ? "destructive" : "primary"}
          requireReason={CONFIRM_META[confirm].requireReason}
          loading={acting}
          onConfirm={(reason) => void runLifecycle(confirm, reason)}
        />
      )}

      <EditResidentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        residentId={id}
        user={user}
        profile={profile}
        onSaved={() => invalidate([`/api/v1/admin/residents/${id}`, "/api/v1/admin/residents", "/api/v1/admin/dashboard"])}
      />

      <ExemptionDialog
        open={exemptionOpen}
        onOpenChange={setExemptionOpen}
        residentId={id}
        residentName={profile.fullName}
        onSaved={() => invalidate([`/api/v1/admin/residents/${id}`, "/api/v1/admin/funds", "/api/v1/admin/residents"])}
      />

    </StaggerGroup>
  );
}

/* -------------------------------------------------------- edit resident */

function toInputDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function EditResidentDialog({
  open,
  onOpenChange,
  residentId,
  user,
  profile,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  residentId: string;
  user: Resident360["user"];
  profile: Resident360["profile"];
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(profile.fullName);
  const [roomNumber, setRoomNumber] = useState(profile.roomNumber ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [emergencyContact, setEmergencyContact] = useState(profile.emergencyContact ?? "");
  const [fromDate, setFromDate] = useState(() => toInputDate(user.membershipEffectiveFrom));
  const [untilDate, setUntilDate] = useState(() => toInputDate(user.membershipEffectiveUntil));
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setFullName(profile.fullName);
      setRoomNumber(profile.roomNumber ?? "");
      setPhone(profile.phone ?? "");
      setEmergencyContact(profile.emergencyContact ?? "");
      setFromDate(toInputDate(user.membershipEffectiveFrom));
      setUntilDate(toInputDate(user.membershipEffectiveUntil));
      setPassword("");
    }
  }, [open, profile, user]);

  async function save() {
    setSaving(true);
    try {
      await patchJson(`/api/v1/admin/residents/${residentId}`, {
        fullName: fullName.trim(),
        roomNumber: roomNumber.trim() || null,
        phone: phone.trim() || null,
        emergencyContact: emergencyContact.trim() || null,
        membershipEffectiveFrom: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : null,
        membershipEffectiveUntil: untilDate ? new Date(`${untilDate}T23:59:59`).toISOString() : null,
        password: password.trim() || undefined,
      });
      toast.success("Resident updated.");
      onSaved();
      onOpenChange(false);
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
      title="Edit resident"
      description="Update profile, room, membership, or reset password."
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </GlassButton>
          <GlassButton loading={saving} onClick={() => void save()}>
            Save changes
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        {/* Profile & Contact */}
        <TextField
          label="Full name"
          value={fullName}
          onChange={setFullName}
          placeholder="Resident full name"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField
            label="Room number"
            value={roomNumber}
            onChange={setRoomNumber}
            placeholder="e.g. B-210"
          />
          <TextField
            label="Phone number"
            value={phone}
            onChange={setPhone}
            placeholder="+91..."
          />
        </div>

        <TextField
          label="Emergency contact"
          value={emergencyContact}
          onChange={setEmergencyContact}
          placeholder="Contact details"
        />

        {/* Membership dates */}
        <div className="border-t border-border/20 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
            Membership dates
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField label="Member from" type="date" value={fromDate} onChange={setFromDate} />
            <TextField
              label="Member until"
              type="date"
              value={untilDate}
              onChange={setUntilDate}
              hint="Leave blank for open-ended."
            />
          </div>
        </div>

        {/* Security / Password */}
        <div className="border-t border-border/20 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
            Account password
          </p>
          <TextField
            label="Reset password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter new password"
            hint="Leave blank to keep existing password."
          />
        </div>
      </div>
    </DetailDialog>
  );
}

/* ------------------------------------------------------------- exemption */

function ExemptionDialog({
  open,
  onOpenChange,
  residentId,
  residentName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  residentId: string;
  residentName: string;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await postJson("/api/v1/admin/policy-exemptions", {
        residentId,
        reason: reason.trim(),
        expiresAt: expiresAt || undefined,
      });
      toast.success("Exemption created", { description: `${residentName} is exempt until ${expiresAt || "cancelled"}.` });
      setReason("");
      setExpiresAt("");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const valid = reason.trim().length >= 3;

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create deficit-policy exemption"
      description="While active, deficit restrictions (meal limiting) are lifted for this resident. Audited with your reason."
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </GlassButton>
          <GlassButton loading={saving} disabled={!valid} onClick={() => void save()}>
            Create exemption
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="Reason"
          value={reason}
          onChange={setReason}
          maxLength={500}
          placeholder="e.g. Salary delayed — settling by month end"
        />
        <TextField
          label="Expires on (optional)"
          type="date"
          value={expiresAt}
          onChange={setExpiresAt}
          hint="Leave empty to keep the exemption until cancelled."
        />
        <div className="glass-inset flex items-center justify-between rounded-md px-3.5 py-2.5">
          <span className="text-xs font-semibold text-muted-foreground">Policy</span>
          <Chip tone="frost">Deficit restriction</Chip>
        </div>
      </div>
    </DetailDialog>
  );
}
