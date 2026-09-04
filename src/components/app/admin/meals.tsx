"use client";

/**
 * Admin Meals — BoardOps kitchen-view layout.
 * Centered date capsule picker → 3 KPI cards → per-meal count cards with
 * color-tinted gradient glass → expandable resident meal-status rows with
 * admin override authority (reason-required confirm, audit trail).
 * GET /api/v1/admin/meals?date= · POST /meals/:instanceId/override
 */

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  Minus,
  Plane,
  Plus,
  RotateCcw,
  ShieldCheck,
  UserPlus,
  UserRound,
  Users,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import { KpiCard } from "@/components/glass/KpiCard";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import MealOrb from "@/components/glass/MealOrb";
import StatusBadge from "@/components/glass/StatusBadge";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { KpiGridSkeleton, ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import GlassToggle from "@/components/glass/GlassToggle";

import { useSession } from "@/hooks/use-session";
import { postJson } from "@/hooks/use-api-query";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";
import { useApiMetaQuery, errMessage, useInvalidate, metaNum } from "./_shared/api";
import { SearchField, mealIcon } from "./_shared/fields";
import { fmtTime, shiftDateKey, mealHex, initialsOf } from "./_shared/format";

const MEALS_PATH = "/api/v1/admin/meals";


interface MealInstanceEntry {
  instance: {
    id: string;
    serviceDate: string;
    serviceWindow: { startAt: string; endAt: string };
    cutoffAt: string;
    status: "OPEN" | "LOCKED" | string;
  };
  definition: { name: string; icon: string | null; colorToken: string | null; mealType: string };
  counts: { confirmed: number; off: number; guests: number; onLeave: number; notAvailable: number };
}

interface ResidentMealEntry {
  residentId: string;
  fullName: string;
  roomNumber: string | null;
  monthlyMealCount: number;
  monthlyGuestCount?: number;
  todayMealCount?: number;
  todayGuestCount?: number;
  today: {
    mealInstanceId: string;
    residentMealId: string;
    name: string;
    effectiveState: string;
    effectiveReason: string;
    baselineState: string;
    residentSelectedState: string | null;
    adminOverrideState: string | null;
    overridden: boolean;
    locked: boolean;
    version: number;
    guestCount?: number;
    guestOverridden?: boolean;
    guestOverrideCount?: number;
  }[];
}

interface MealsData {
  date: string;
  timezone: string;
  instances: MealInstanceEntry[];
  residents: ResidentMealEntry[];
}

interface OverrideTarget {
  resident: ResidentMealEntry;
  meal: ResidentMealEntry["today"][number];
  state: "ON" | "OFF";
}

interface GuestOverrideTarget {
  resident: ResidentMealEntry;
  meal: ResidentMealEntry["today"][number];
  currentQuantity: number;
  targetQuantity: number;
}

/* ------------------------------- helpers -------------------------------- */

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function weekdayShort(key: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(parseKey(key));
}

function dateShortLabel(key: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(parseKey(key));
}

/** Capsule labels — relative for ±1 day, compact otherwise (BoardOps pattern). */
function datePillLabels(key: string, todayKey: string): { top: string; bottom: string } {
  const base = `${weekdayShort(key)}, ${dateShortLabel(key)}`;
  if (key === todayKey) return { top: "Today", bottom: base };
  if (key === shiftDateKey(todayKey, -1)) return { top: "Yesterday", bottom: base };
  if (key === shiftDateKey(todayKey, 1)) return { top: "Tomorrow", bottom: base };
  return { top: dateShortLabel(key), bottom: weekdayShort(key) };
}

function stateLabel(state: string): string {
  switch (state) {
    case "ON":
      return "On";
    case "OFF":
      return "Off";
    case "ON_LEAVE":
      return "Leave";
    default:
      return "Not available";
  }
}

/* -------------------------------- mini chip -------------------------------- */

function MiniChip({
  tone = "neutral",
  icon: Icon,
  children,
}: {
  tone?: "success" | "warning" | "danger" | "primary" | "neutral";
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/15 text-danger",
    primary: "bg-primary/15 text-primary",
    neutral: "bg-muted/80 text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap rounded-pill px-1.5 py-0.5 text-[10px] font-medium",
        tones[tone]
      )}
    >
      {Icon && <Icon className="size-2.5" aria-hidden />}
      {children}
    </span>
  );
}

/* ----------------------------- circle arrow ----------------------------- */

function CircleArrow({
  direction,
  onClick,
  disabled,
  label,
}: {
  direction: "prev" | "next";
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.9 }}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="glass-strong flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-pill transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon className="size-5" aria-hidden />
    </motion.button>
  );
}

/* -------------------------------- the view ------------------------------- */

export default function AdminMeals() {
  const [dateParam, setDateParam] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [expandedResident, setExpandedResident] = useState<string | null>(null);
  const [override, setOverride] = useState<OverrideTarget | null>(null);
  const [acting, setActing] = useState(false);
  const [guestOverride, setGuestOverride] = useState<GuestOverrideTarget | null>(null);
  const [actingGuest, setActingGuest] = useState(false);

  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";



  /** Server "today" — captured from the first (undated) fetch. */
  const todayKeyRef = useRef<string | null>(null);

  const query = useApiMetaQuery<MealsData>(MEALS_PATH, { date: dateParam });
  const { isLoading, error, refetch, data: envelope } = query;
  const data = envelope?.data;
  const meta = envelope?.meta ?? {};

  const activeDate = data?.date;
  if (activeDate && todayKeyRef.current === null) {
    todayKeyRef.current = activeDate;
  }
  const todayKey = todayKeyRef.current;
  const isToday = activeDate === todayKey;

  const filteredResidents = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data?.residents ?? [];
    if (!q) return list;
    return list.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.roomNumber ?? "").toLowerCase().includes(q)
    );
  }, [data, search]);

  /** Today's totals computed from the per-instance counts (BoardOps pattern).
   *  regular: resident meals ON, guests: guest meals booked, meals: grand total. */
  const totals = useMemo(() => {
    const instances = data?.instances ?? [];
    const regular = instances.reduce((s, c) => s + c.counts.confirmed, 0);
    const guests = instances.reduce((s, c) => s + c.counts.guests, 0);
    return {
      regular,
      guests,
      meals: regular + guests,
      off: instances.reduce((s, c) => s + c.counts.off, 0),
    };
  }, [data]);

  async function runOverride(reason: string | undefined) {
    if (!override) return;
    setActing(true);
    try {
      await postJson(`${MEALS_PATH}/${override.meal.mealInstanceId}/override`, {
        residentId: override.resident.residentId,
        state: override.state,
        reason,
      });
      invalidate([MEALS_PATH, "/api/v1/admin/dashboard", "/api/v1/meals", "/api/v1/me/dashboard"]);
      toast.success("Meal updated", {
        description: `${override.resident.fullName} · ${override.meal.name} → ${override.state === "ON" ? "On" : "Off"}`,
      });
      setOverride(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function runGuestOverride(reason: string | undefined) {
    if (!guestOverride) return;
    setActingGuest(true);
    try {
      await postJson(`${MEALS_PATH}/${guestOverride.meal.mealInstanceId}/guest-override`, {
        residentId: guestOverride.resident.residentId,
        quantity: guestOverride.targetQuantity,
        reason,
      });
      invalidate([MEALS_PATH, "/api/v1/admin/dashboard"]);
      toast.success("Guest meals updated", {
        description: `${guestOverride.resident.fullName} · ${guestOverride.meal.name} → ${guestOverride.targetQuantity} guest${guestOverride.targetQuantity === 1 ? "" : "s"}`,
      });
      setGuestOverride(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActingGuest(false);
    }
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-3 sm:gap-4">
          <div className="glass-skeleton size-10 rounded-pill" />
          <div className="glass-skeleton h-12 w-full max-w-[280px] rounded-pill" />
          <div className="glass-skeleton size-10 rounded-pill" />
        </div>
        <KpiGridSkeleton count={3} />
        <ListSkeleton rows={4} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <ErrorState
        code={(error as ApiClientError | undefined)?.code}
        message={(error as ApiClientError | undefined)?.message}
        onRetry={() => void refetch()}
      />
    );
  }

  const daySub = isToday ? "Today" : activeDate ? dateShortLabel(activeDate) : undefined;
  const pill = activeDate ? datePillLabels(activeDate, todayKey ?? activeDate) : null;

  return (
    <StaggerGroup className="space-y-4">
      {/* Date capsule — centered text + circular arrows (BoardOps pattern) */}
      <StaggerItem>
      <div className="flex items-center justify-center gap-3 sm:gap-4">
        <CircleArrow
          direction="prev"
          label="Previous day"
          disabled={!activeDate}
          onClick={() => activeDate && setDateParam(shiftDateKey(activeDate, -1))}
        />
        <button
          type="button"
          onClick={() => {
            if (activeDate && todayKey && activeDate !== todayKey) setDateParam(todayKey);
          }}
          className="glass flex min-w-0 max-w-[280px] flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-pill px-4 py-2.5 transition-all hover:ring-1 hover:ring-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-6"
        >
          <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
          {pill && (
            <span className="min-w-0 text-center leading-tight">
              <span className="block truncate text-sm font-bold text-primary">{pill.top}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{pill.bottom}</span>
            </span>
          )}
          {!isToday && <RotateCcw className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
        </button>
        <CircleArrow
          direction="next"
          label="Next day"
          disabled={!activeDate}
          onClick={() => activeDate && setDateParam(shiftDateKey(activeDate, 1))}
        />
      </div>
      </StaggerItem>

      {/* KPI cards — User meals & Guest meals side-by-side (showing both day count & month total) */}
      <StaggerItem>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <KpiCard
          label="User meals"
          value={String(totals.regular)}
          sub={daySub ?? "Today"}
          icon={<Utensils />}
          glow="success"
          tone="success"
          index={0}
        />
        <KpiCard
          label="Guest meals"
          value={String(totals.guests)}
          sub={daySub ?? "Today"}
          icon={<UserPlus />}
          glow="primary"
          tone="primary"
          index={1}
        />
        <KpiCard
          label="Off"
          value={String(totals.off)}
          sub="Skipped"
          icon={<X />}
          glow="warning"
          tone="warning"
          index={2}
        />
      </div>
      </StaggerItem>

      {/* Per-meal count cards */}
      <StaggerItem>
      {data.instances.length === 0 ? (
        <EmptyState
          icon={Utensils}
          title="No meals configured for this date"
          description="Meal instances are generated from active meal definitions — check the schedule in Meal Configuration."
        />
      ) : (
        <div className="grid-cards gap-3">
          {data.instances.map((entry) => {
            const Icon = mealIcon(entry.definition.icon);
            const locked = entry.instance.status !== "OPEN";
            const hex = mealHex(entry.definition.colorToken);
            const total = entry.counts.confirmed + entry.counts.guests;
            const cutoffPassed =
              locked || new Date(entry.instance.cutoffAt).getTime() <= Date.now();
            return (
              <motion.div
                key={entry.instance.id}
                whileHover={{ y: -4, scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                transition={SPRING_SNAPPY}
                onClick={() => {
                  if (!cutoffPassed) {
                    toast.info("Override after cutoff", { id: "admin-cutoff-override" });
                  }
                }}
                className={cn(
                  "glass relative overflow-hidden rounded-3xl",
                  !cutoffPassed && "cursor-pointer"
                )}
                style={{
                  background: `linear-gradient(135deg, ${hex}2e 0%, ${hex}0a 55%, transparent 100%)`,
                  borderColor: `${hex}50`,
                  boxShadow: `0 8px 32px -10px ${hex}40, inset 0 1px 0 0 ${hex}22`,
                }}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full opacity-40 blur-3xl"
                  style={{ background: hex }}
                />
                <div className="relative p-3.5 sm:p-4">
                  {/* Top row: Meal Icon + Name & Hours (Left), Big Total Count & Cutoff (Right) */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <MealOrb icon={<Icon />} colorToken={entry.definition.colorToken} size="md" />
                      <div className="min-w-0">
                        <h3 className="truncate text-base sm:text-lg font-bold text-foreground tracking-tight">
                          {entry.definition.name}
                        </h3>
                        <p className="kpi-num mt-0.5 text-xs font-medium text-muted-foreground">
                          {fmtTime(entry.instance.serviceWindow.startAt, tz)} – {fmtTime(entry.instance.serviceWindow.endAt, tz)}
                        </p>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="flex items-baseline justify-end gap-1">
                        <span
                          className={cn(
                            "kpi-num font-extrabold text-foreground tracking-tight leading-none transition-all duration-200",
                            String(total).length <= 3 ? "text-3xl" : String(total).length <= 5 ? "text-2xl" : "text-xl"
                          )}
                        >
                          {total}
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          total
                        </span>
                      </div>
                      <p className="kpi-num mt-1 text-[11px] font-medium text-muted-foreground">
                        {locked ? (
                          <span className="font-semibold text-danger">Locked</span>
                        ) : (
                          <span>Cutoff {fmtTime(entry.instance.cutoffAt, tz)}</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Bottom row: Breakdown chips in a compact horizontal strip */}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-1.5 border-t border-border/20 pt-2.5">
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      <span className="kpi-num inline-flex items-center gap-1 rounded-xl bg-primary/12 px-2.5 py-0.5 text-xs font-medium text-primary">
                        <span className="text-muted-foreground">User meals:</span> <strong>{entry.counts.confirmed}</strong>
                      </span>
                      <span
                        className="kpi-num inline-flex items-center gap-1 rounded-xl px-2.5 py-0.5 text-xs font-medium"
                        style={{ backgroundColor: `${hex}25`, color: hex }}
                      >
                        <span className="opacity-80">Guest meals:</span> <strong>{entry.counts.guests}</strong>
                      </span>
                      <span className="kpi-num inline-flex items-center gap-1 rounded-xl bg-warning/15 px-2.5 py-0.5 text-xs font-medium text-warning">
                        <span className="opacity-80">OFF:</span> <strong>{entry.counts.off}</strong>
                      </span>
                    </div>

                    {(entry.counts.onLeave > 0 || entry.counts.notAvailable > 0) && (
                      <div className="kpi-num text-[11px] text-muted-foreground">
                        {entry.counts.onLeave > 0 && <span>{entry.counts.onLeave} leave</span>}
                        {entry.counts.onLeave > 0 && entry.counts.notAvailable > 0 && " · "}
                        {entry.counts.notAvailable > 0 && <span>{entry.counts.notAvailable} n/a</span>}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
      </StaggerItem>


      {/* Resident meal status — expandable rows with admin override */}
      <StaggerItem>
      <section className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <Users className="size-5 text-primary" aria-hidden />
          <h3 className="font-semibold text-base">Resident meal status</h3>
        </div>

        <div>
          <SearchField value={search} onChange={setSearch} placeholder="Filter residents by name or room…" />
        </div>

          {filteredResidents.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title={search ? "No residents match" : "No residents with meals today"}
              description={search ? "Try a different name or room." : "Active residents appear here once meals materialize."}
            />
          ) : (
            <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto">
              {filteredResidents.map((r) => {
                const isExpanded = expandedResident === r.residentId;
                const onCount = r.today.filter((m) => m.effectiveState === "ON").length;
                const offCount = r.today.filter((m) => m.effectiveState === "OFF").length;
                const leaveCount = r.today.filter((m) => m.effectiveState === "ON_LEAVE").length;
                const lockedCount = r.today.filter(
                  (m) =>
                    m.effectiveState !== "ON_LEAVE" &&
                    (m.locked ||
                      data.instances.find((i) => i.instance.id === m.mealInstanceId)?.instance.status !== "OPEN")
                ).length;
                const adminCount = r.today.filter((m) => m.overridden || m.effectiveReason === "ADMIN_OVERRIDE").length;
                const guestAdminOverrideTotal = r.today.reduce((s, m) => s + (m.guestOverrideCount ?? 0), 0);
                const todayGuestCount = r.todayGuestCount ?? r.today.reduce((s, m) => s + (m.guestCount ?? 0), 0);
                return (
                  <GlassCard key={r.residentId} className="overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedResident(isExpanded ? null : r.residentId)}
                      aria-expanded={isExpanded}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]",
                        isExpanded && "border-b border-border/25"
                      )}
                    >
                      <span
                        aria-hidden
                        className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold text-primary"
                      >
                        {initialsOf(r.fullName)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">{r.fullName}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {r.roomNumber ? `Room ${r.roomNumber}` : "No room"}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {onCount > 0 && (
                            <MiniChip tone="success" icon={Check}>
                              {onCount} ON
                            </MiniChip>
                          )}
                          {offCount > 0 && (
                            <MiniChip tone="warning" icon={X}>
                              {offCount} OFF
                            </MiniChip>
                          )}
                          {leaveCount > 0 && (
                            <MiniChip tone="neutral" icon={Plane}>
                              Leave
                            </MiniChip>
                          )}
                          {lockedCount > 0 && (
                            <MiniChip tone="danger" icon={Lock}>
                              {lockedCount}
                            </MiniChip>
                          )}
                          {todayGuestCount > 0 && (
                            <MiniChip tone="primary" icon={Users}>
                              {todayGuestCount} {todayGuestCount === 1 ? "guest" : "guests"}
                            </MiniChip>
                          )}
                          {adminCount > 0 && (
                            <MiniChip tone="primary" icon={ShieldCheck}>
                              {adminCount} override
                            </MiniChip>
                          )}
                          {guestAdminOverrideTotal > 0 && (
                            <MiniChip tone="primary" icon={Users}>
                              {guestAdminOverrideTotal} guest {guestAdminOverrideTotal === 1 ? "override" : "overrides"}
                            </MiniChip>
                          )}
                          {r.today.length === 0 && (
                            <span className="text-[11px] text-muted-foreground">No meals</span>
                          )}
                        </div>
                      </span>
                      <motion.span
                        animate={{ rotate: isExpanded ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex shrink-0 items-center text-muted-foreground"
                      >
                        <ChevronDown className="size-4" aria-hidden />
                      </motion.span>
                    </button>

                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="space-y-2.5 p-3">
                            {/* Monthly tally banner */}
                            <div className="flex items-center gap-3 rounded-2xl bg-primary/10 p-3 ring-1 ring-primary/20 transition-all">
                              <span className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary [&_svg]:size-4">
                                <Utensils className="size-4" aria-hidden />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold leading-tight text-foreground">
                                  Total meals consumed
                                </p>
                                <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
                                  This month
                                </p>
                              </div>
                              <span className="kpi-num inline-flex h-9 min-w-10 shrink-0 items-center justify-center rounded-xl bg-primary px-2.5 text-sm font-bold text-primary-foreground shadow-sm">
                                {r.monthlyMealCount}
                              </span>
                            </div>

                            {r.today.map((meal) => {
                              const instance = data.instances.find((i) => i.instance.id === meal.mealInstanceId);
                              const cutoffPassed = instance
                                ? new Date(instance.instance.cutoffAt).getTime() <= Date.now() || instance.instance.status !== "OPEN"
                                : false;
                              const lockedNow = meal.locked || cutoffPassed;
                              const canAdminOverride = lockedNow;
                              const isOn = meal.effectiveState === "ON";
                              const RowIcon: LucideIcon = mealIcon(instance?.definition.icon);
                              const mealGuestCount = meal.guestCount ?? 0;

                              const showCutoffToast = (e?: React.MouseEvent) => {
                                e?.stopPropagation?.();
                                toast.info("Override after cutoff", {
                                  id: "admin-cutoff-override",
                                });
                              };

                              return (
                                <div
                                  key={meal.mealInstanceId}
                                  onClick={() => {
                                    if (!canAdminOverride) {
                                      showCutoffToast();
                                    }
                                  }}
                                  className={cn(
                                    "glass-inset hover:glass border border-border/40 group rounded-2xl sm:rounded-3xl p-3 sm:p-3.5 transition-all hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]",
                                    !canAdminOverride && "cursor-pointer"
                                  )}
                                >
                                  <div className="flex items-center gap-3">
                                    <MealOrb icon={<RowIcon />} colorToken={instance?.definition.colorToken} size="sm" />
                                    <div className="min-w-0 flex-1 flex flex-col justify-center py-0.5">
                                      {/* Line 1: Meal Name (lifted) + Status Badges */}
                                      <div className="flex flex-wrap items-center gap-1.5 -mt-0.5">
                                        <p className="truncate text-sm font-bold leading-tight text-foreground">{meal.name}</p>
                                        {lockedNow && (
                                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-danger">
                                            <Lock className="size-2.5" aria-hidden /> Locked
                                          </span>
                                        )}
                                        {(meal.overridden || meal.effectiveReason === "ADMIN_OVERRIDE") && (
                                          <span className="inline-flex items-center gap-0.5 rounded-pill bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                            <ShieldCheck className="size-2.5" aria-hidden /> Overridden
                                          </span>
                                        )}
                                        {meal.guestOverridden && (meal.guestOverrideCount ?? 0) > 0 && (
                                          <span className="inline-flex items-center gap-0.5 rounded-pill bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                            <Users className="size-2.5" aria-hidden /> {meal.guestOverrideCount} overridden
                                          </span>
                                        )}
                                        {meal.effectiveState !== "ON" && meal.effectiveState !== "OFF" && meal.effectiveState !== "ON_LEAVE" && (
                                          <StatusBadge status={meal.effectiveState} label={stateLabel(meal.effectiveState)} />
                                        )}
                                      </div>

                                      {/* Line 2: Service time */}
                                      <p className="mt-0.5 truncate text-[11px] font-medium leading-tight text-muted-foreground">
                                        <span className="kpi-num">
                                          {instance
                                            ? `${fmtTime(instance.instance.serviceWindow.startAt, tz)} – ${fmtTime(instance.instance.serviceWindow.endAt, tz)}`
                                            : ""}
                                        </span>
                                      </p>

                                      {/* Line 3: Cutoff text below service time */}
                                      <p className="mt-0.5 truncate text-[10px] font-medium leading-tight text-muted-foreground/80">
                                        {lockedNow ? (
                                          <span className="kpi-num opacity-70">Cutoff passed</span>
                                        ) : instance ? (
                                          <span className="kpi-num text-primary/80">
                                            Cutoff {fmtTime(instance.instance.cutoffAt, tz)}
                                          </span>
                                        ) : null}
                                      </p>
                                    </div>

                                    <div className="flex shrink-0 items-center gap-2">
                                      {/* Guest meals control — admin can only override after cutoff */}
                                      {mealGuestCount > 0 ? (
                                        <div
                                          className="glass-inset hover:glass border border-border/40 flex shrink-0 items-center gap-1 rounded-full p-0.5 h-8.5 shadow-sm transition-all"
                                          aria-label={`${meal.name}: ${mealGuestCount} ${mealGuestCount === 1 ? "guest" : "guests"}`}
                                        >
                                          <Users className="ml-1.5 mr-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                                          <motion.button
                                            type="button"
                                            aria-disabled={!canAdminOverride}
                                            whileHover={canAdminOverride ? { scale: 1.08 } : undefined}
                                            whileTap={canAdminOverride ? { scale: 0.88 } : undefined}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (!canAdminOverride) {
                                                showCutoffToast();
                                                return;
                                              }
                                              setGuestOverride({
                                                resident: r,
                                                meal,
                                                currentQuantity: mealGuestCount,
                                                targetQuantity: mealGuestCount - 1,
                                              });
                                            }}
                                            aria-label={`Remove one guest from ${meal.name}`}
                                            className={cn(
                                              "flex size-7 items-center justify-center rounded-full bg-foreground/[0.08] dark:bg-white/[0.12] text-foreground hover:bg-foreground/[0.16] dark:hover:bg-white/[0.22] hover:text-primary transition-all shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                                              canAdminOverride ? "cursor-pointer" : "cursor-not-allowed opacity-30"
                                            )}
                                          >
                                            <Minus className="size-3.5 stroke-[3]" aria-hidden />
                                          </motion.button>
                                          <motion.span
                                            key={mealGuestCount}
                                            initial={{ scale: 0.85, opacity: 0.6 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            transition={{ type: "spring", stiffness: 500, damping: 28 }}
                                            className="kpi-num w-5 text-center text-xs font-bold text-foreground"
                                            aria-live="polite"
                                          >
                                            {mealGuestCount}
                                          </motion.span>
                                          <motion.button
                                            type="button"
                                            aria-disabled={!canAdminOverride}
                                            whileHover={canAdminOverride ? { scale: 1.08 } : undefined}
                                            whileTap={canAdminOverride ? { scale: 0.88 } : undefined}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (!canAdminOverride) {
                                                showCutoffToast();
                                                return;
                                              }
                                              setGuestOverride({
                                                resident: r,
                                                meal,
                                                currentQuantity: mealGuestCount,
                                                targetQuantity: mealGuestCount + 1,
                                              });
                                            }}
                                            aria-label={`Add one guest to ${meal.name}`}
                                            className={cn(
                                              "flex size-7 items-center justify-center rounded-full bg-foreground/[0.08] dark:bg-white/[0.12] text-foreground hover:bg-foreground/[0.16] dark:hover:bg-white/[0.22] hover:text-primary transition-all shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                                              canAdminOverride ? "cursor-pointer" : "cursor-not-allowed opacity-30"
                                            )}
                                          >
                                            <Plus className="size-3.5 stroke-[3]" aria-hidden />
                                          </motion.button>
                                        </div>
                                      ) : (
                                        <motion.button
                                          type="button"
                                          aria-disabled={!canAdminOverride}
                                          whileHover={canAdminOverride ? { scale: 1.02 } : undefined}
                                          whileTap={canAdminOverride ? { scale: 0.96 } : undefined}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (!canAdminOverride) {
                                              showCutoffToast();
                                              return;
                                            }
                                            setGuestOverride({
                                              resident: r,
                                              meal,
                                              currentQuantity: 0,
                                              targetQuantity: 1,
                                            });
                                          }}
                                          aria-label={`Add guest to ${meal.name}`}
                                          className={cn(
                                            "glass-inset hover:glass border border-border/40 hover:border-border/70 inline-flex h-8.5 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-foreground transition-all hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring shadow-sm",
                                            canAdminOverride ? "cursor-pointer" : "cursor-not-allowed opacity-40"
                                          )}
                                        >
                                          <UserPlus className="size-3.5 shrink-0 text-primary" aria-hidden />
                                          <span>+ Guest</span>
                                        </motion.button>
                                      )}

                                      {/* Meal status switch or Leave label */}
                                      {meal.effectiveState === "ON_LEAVE" ? (
                                        <StatusBadge status="ON_LEAVE" label="Leave" icon={Plane} />
                                      ) : (
                                        <GlassToggle
                                          checked={isOn}
                                          disabled={!canAdminOverride}
                                          onDisabledClick={showCutoffToast}
                                          onChange={() =>
                                            canAdminOverride &&
                                            setOverride({
                                              resident: r,
                                              meal,
                                              state: isOn ? "OFF" : "ON",
                                            })
                                          }
                                          label={`${meal.name} for ${r.fullName} — currently ${stateLabel(meal.effectiveState)}.${canAdminOverride ? ` Admin override to ${isOn ? "off" : "on"}.` : " Cutoff has not passed yet."}`}
                                        />
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </GlassCard>
                );
              })}
            </div>
          )}
      </section>
      </StaggerItem>

      {/* Override confirm — reason required for the audit trail */}
      {override && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setOverride(null)}
          title={`${override.state === "ON" ? "Turn meal on" : "Turn meal off"} — ${override.meal.name}`}
          description={
            <>
              {override.meal.locked
                ? "This meal is already locked for residents. Your admin override applies after the cutoff and is recorded in the audit trail with your reason."
                : "The resident's own choice is replaced by your decision. Residents are notified and the change is audited."}
              <span className="mt-2 block font-medium">
                {override.resident.fullName} · {override.meal.name} → {override.state === "ON" ? "On" : "Off"}
              </span>
            </>
          }
          confirmLabel={override.state === "ON" ? "Set on" : "Set off"}
          tone={override.state === "OFF" ? "destructive" : "primary"}
          requireReason
          reasonPlaceholder="Reason (required for the audit trail)"
          loading={acting}
          onConfirm={(reason) => void runOverride(reason)}
        />
      )}

      {/* Guest override confirm — reason required for the audit trail */}
      {guestOverride && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setGuestOverride(null)}
          title={`${guestOverride.targetQuantity > guestOverride.currentQuantity ? "Add guest meal" : "Remove guest meal"} — ${guestOverride.meal.name}`}
          description={
            <>
              {guestOverride.meal.locked
                ? "This meal is already locked for residents. Your admin override applies after the cutoff and is recorded in the audit trail with your reason."
                : "The resident's guest meal count is modified by your decision. Residents are notified and the change is audited."}
              <span className="mt-2 block font-medium">
                {guestOverride.resident.fullName} · {guestOverride.meal.name} → {guestOverride.currentQuantity} to {guestOverride.targetQuantity} {guestOverride.targetQuantity === 1 ? "guest" : "guests"}
              </span>
            </>
          }
          confirmLabel={guestOverride.targetQuantity === 0 ? "Remove guests" : `Set to ${guestOverride.targetQuantity} guest${guestOverride.targetQuantity === 1 ? "" : "s"}`}
          tone={guestOverride.targetQuantity === 0 ? "destructive" : "primary"}
          requireReason
          reasonPlaceholder="Reason (required for the audit trail)"
          loading={actingGuest}
          onConfirm={(reason) => void runGuestOverride(reason)}
        />
      )}


    </StaggerGroup>
  );
}
