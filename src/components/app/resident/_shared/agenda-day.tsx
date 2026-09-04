"use client";

/**
 * Shared "agenda day section" — the BoardOps-style day card used in THREE
 * places: the resident meals agenda, the meals Day view, and the resident
 * dashboard's current-day block. One component = one look everywhere:
 * a circular gradient date disc (today pops in primary), the day title,
 * status chips (✓N ON / ×N OFF / 🔒N), a rotating chevron, and collapsible
 * glass-inset meal rows with per-meal gradient orbs and toggles.
 *
 * GUEST MEALS ARE PART OF THE MEAL ROW FLOW: every meal row carries its own
 * guest stepper (±) / "+ Guest" affordance — self-service under cutoff, no
 * admin permission, exactly like the meal ON/OFF toggle. Guests are a
 * separate domain: NEVER counted in the ON/OFF/locked chips (the day header
 * keeps a dedicated guests chip with the day total).
 *
 * Pages adapt their own DTOs into AgendaMealRowVm via the two adapters and
 * keep their own optimistic-toggle handlers (spec §114).
 */

import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Lock,
  Minus,
  Plane,
  Plus,
  ShieldCheck,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import GlassCard from "@/components/glass/GlassCard";
import MealOrb from "@/components/glass/MealOrb";
import StatusBadge from "@/components/glass/StatusBadge";
import GlassToggle from "@/components/glass/GlassToggle";
import { cn } from "@/lib/utils";

import { countdownLabel, formatWindowInTz } from "./format";
import { MealIcon } from "./icons";
import { FormNotice } from "./ui";
import type { DashboardTodayMeal, MealInstanceDto } from "./types";

/* ------------------------------ shared helpers ----------------------------- */

export interface Flash {
  tone: "warning" | "danger" | "info";
  text: string;
}

export const NOT_AVAILABLE_REASONS: Record<string, string> = {
  CALENDAR: "Kitchen closed this day",
  POLICY: "Paused on your account — talk to the admin",
  MEMBERSHIP_NOT_ACTIVE: "Outside your membership dates",
  DEFINITION_HIDDEN: "Not served anymore",
};

export function stateLabel(state: string | null): string {
  switch (state) {
    case "ON":
      return "On";
    case "OFF":
      return "Off";
    case "ON_LEAVE":
      return "Leave";
    default:
      return state ? "Not available" : "Not set";
  }
}

/* ------------------------------- date helpers ------------------------------ */

/** "YYYY-MM-DD" (UTC key) → Date. */
export function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function weekdayShort(key: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(parseKey(key));
}

export function dayNum(key: string): string {
  return String(parseKey(key).getUTCDate());
}

/** "Monday, 3 September". */
export function longDayLabel(key: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    parseKey(key)
  );
}

/* -------------------------------- mini chip -------------------------------- */

export function MiniChip({
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

/* ------------------------------- meal row VM ------------------------------- */

/** Normalized agenda meal row — every producing page maps its DTO into this. */
export interface AgendaMealRowVm {
  id: string;
  name: string;
  icon: string | null;
  colorToken: string | null;
  windowLabel: string;
  cutoffLeftMs: number;
  state: string | null;
  overridden: boolean;
  guestOverridden?: boolean;
  guestOverrideCount?: number;
  /** Combined: server lock OR cutoff already passed. */
  locked: boolean;
  guests: number;
  notAvailableLabel?: string;
  toggleLabel: string;
}

/** MealInstanceDto (GET /api/v1/meals) → agenda row. */
export function agendaRowFromInstance(
  meal: MealInstanceDto,
  tz: string,
  now: number,
  guests: number,
  guestOverridden = false,
  guestOverrideCount = 0
): AgendaMealRowVm {
  const state = meal.myState.effectiveState;
  return {
    id: meal.id,
    name: meal.name,
    icon: meal.icon,
    colorToken: meal.colorToken,
    windowLabel: formatWindowInTz(meal.serviceWindow.startAt, meal.serviceWindow.endAt, tz),
    cutoffLeftMs: new Date(meal.cutoffAt).getTime() - now,
    state,
    overridden: meal.myState.overridden || meal.myState.effectiveReason === "ADMIN_OVERRIDE",
    guestOverridden,
    guestOverrideCount,
    locked: meal.myState.locked || new Date(meal.cutoffAt).getTime() <= now,
    guests,
    notAvailableLabel:
      state === "NOT_AVAILABLE" && meal.myState.effectiveReason in NOT_AVAILABLE_REASONS
        ? NOT_AVAILABLE_REASONS[meal.myState.effectiveReason]
        : undefined,
    toggleLabel: `${meal.name} on ${meal.serviceDate}: ${stateLabel(state)}`,
  };
}

/** DashboardTodayMeal (GET /api/v1/me/dashboard) → agenda row. */
export function agendaRowFromDashboard(
  meal: DashboardTodayMeal,
  tz: string,
  now: number,
  guests = 0,
  guestOverridden = false,
  guestOverrideCount = 0
): AgendaMealRowVm {
  const state = meal.myState;
  const overridden = meal.myReason === "ADMIN_OVERRIDE";
  return {
    id: meal.id,
    name: meal.mealName,
    icon: meal.icon,
    colorToken: meal.colorToken,
    windowLabel: formatWindowInTz(meal.serviceStartAt, meal.serviceEndAt, tz),
    cutoffLeftMs: new Date(meal.cutoffAt).getTime() - now,
    state,
    overridden,
    guestOverridden,
    guestOverrideCount,
    locked: meal.locked || new Date(meal.cutoffAt).getTime() <= now,
    guests,
    notAvailableLabel:
      state === "NOT_AVAILABLE" && meal.myReason != null && meal.myReason in NOT_AVAILABLE_REASONS
        ? NOT_AVAILABLE_REASONS[meal.myReason]
        : undefined,
    toggleLabel: `${meal.mealName} today: ${stateLabel(state)}`,
  };
}

/* ------------------------------ guest stepper ------------------------------ */

/** Normalized day-guest entry — used for the day-header guests chip total. */
export interface AgendaGuestMealVm {
  id: string;
  mealInstanceId: string;
  mealName: string;
  quantity: number;
  totalPriceMinor: number;
  status: string;
  /** Instance cutoff instant (ISO) — kept so steppers can pick a target. */
  cutoffAt: string;
}

/** Guest rows (guest-meals list DTO or dashboard todayGuests) → agenda VMs. */
export function agendaGuestRows(
  guests: { id: string; mealInstanceId: string; mealName: string; quantity: number; totalPriceMinor: number; status: string; cutoffAt: string }[],
  _now: number
): AgendaGuestMealVm[] {
  return guests.map((g) => ({ ...g }));
}

/**
 * The per-meal GUEST control — part of the meal row flow, exactly like the
 * ON/OFF toggle: "+ Guest" when none yet, a compact ± stepper when there
 * are guests (read-only once the cutoff passed). Self-service, no admin
 * permission; guests are never counted as normal locked meals.
 */
export function MealGuestStepper({
  guests,
  changeable,
  onStep,
  onAdd,
  mealName,
}: {
  guests: number;
  changeable: boolean;
  onStep?: (delta: 1 | -1) => void;
  onAdd?: () => void;
  mealName: string;
}) {
  if (guests > 0) {
    return (
      <div
        className="glass-inset hover:glass border border-border/40 flex shrink-0 items-center gap-1 rounded-full p-0.5 h-8.5 shadow-sm transition-all"
        aria-label={`${mealName}: ${guests} ${guests === 1 ? "guest" : "guests"}`}
      >
        <Users className="ml-1.5 mr-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
        <motion.button
          type="button"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.88 }}
          onClick={() => onStep?.(-1)}
          disabled={!changeable}
          aria-label={`Remove one guest from ${mealName}`}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-foreground/[0.08] dark:bg-white/[0.12] text-foreground hover:bg-foreground/[0.16] dark:hover:bg-white/[0.22] hover:text-primary transition-all disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring shadow-sm"
        >
          <Minus className="size-3.5 stroke-[3]" aria-hidden />
        </motion.button>
        <motion.span
          key={guests}
          initial={{ scale: 0.85, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 28 }}
          className="kpi-num w-5 text-center text-xs font-bold text-foreground"
          aria-live="polite"
        >
          {guests}
        </motion.span>
        <motion.button
          type="button"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.88 }}
          onClick={() => onStep?.(1)}
          disabled={!changeable}
          aria-label={`Add one guest to ${mealName}`}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-foreground/[0.08] dark:bg-white/[0.12] text-foreground hover:bg-foreground/[0.16] dark:hover:bg-white/[0.22] hover:text-primary transition-all disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring shadow-sm"
        >
          <Plus className="size-3.5 stroke-[3]" aria-hidden />
        </motion.button>
      </div>
    );
  }
  return (
    <motion.button
      type="button"
      whileHover={changeable ? { scale: 1.02 } : undefined}
      whileTap={changeable ? { scale: 0.96 } : undefined}
      onClick={changeable ? onAdd : undefined}
      disabled={!changeable}
      aria-label={`Add guest to ${mealName}`}
      className="glass-inset hover:glass border border-border/40 hover:border-border/70 inline-flex h-8.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-foreground transition-all hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
    >
      <UserPlus className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span>+ Guest</span>
    </motion.button>
  );
}

/* ------------------------------ agenda meal row ---------------------------- */

export function AgendaMealRow({
  row,
  flash,
  guestFlash,
  onToggle,
  onGuestStep,
  onAddGuest,
}: {
  row: AgendaMealRowVm;
  flash?: Flash;
  /** Inline guest-stepper flash (per instance). */
  guestFlash?: Flash;
  onToggle: (row: AgendaMealRowVm, next: "ON" | "OFF") => void;
  onGuestStep?: (row: AgendaMealRowVm, delta: 1 | -1) => void;
  onAddGuest?: (row: AgendaMealRowVm) => void;
}) {
  const state = row.state;
  /** Guests can be added/adjusted while the cutoff is ahead (even if resident is on leave). */
  const guestChangeable = row.cutoffLeftMs > 0 && state !== "NOT_AVAILABLE";

  return (
    <div className="glass-inset hover:glass border border-border/40 group rounded-2xl sm:rounded-3xl transition-all hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]">
      <div className="flex items-center gap-3 p-3 sm:p-3.5">
        <MealOrb icon={<MealIcon name={row.icon} />} colorToken={row.colorToken} size="sm" />
        <div className="min-w-0 flex-1 flex flex-col justify-center py-0.5">
          {/* Line 1: Meal Name (lifted) + Status Badges */}
          <div className="flex flex-wrap items-center gap-1.5 -mt-0.5">
            <p className="truncate text-sm font-bold leading-tight text-foreground">{row.name}</p>
            {row.locked && row.state === "ON" && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-danger">
                <Lock className="size-2.5" aria-hidden /> Locked
              </span>
            )}
            {row.overridden && (
              <span className="inline-flex items-center gap-0.5 rounded-pill bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <ShieldCheck className="size-2.5" aria-hidden /> Overridden
              </span>
            )}
            {row.guestOverridden && (row.guestOverrideCount ?? 0) > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded-pill bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <Users className="size-2.5" aria-hidden /> {row.guestOverrideCount} overridden
              </span>
            )}
            {state === "ON_LEAVE" && (
              <span className="inline-flex items-center gap-0.5 rounded-pill bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                <Plane className="size-2.5" aria-hidden /> Leave
              </span>
            )}
            {row.notAvailableLabel && (
              <span className="text-[10px] font-medium text-muted-foreground">{row.notAvailableLabel}</span>
            )}
          </div>

          {/* Line 2: Service time */}
          <p className="mt-0.5 truncate text-[11px] font-medium leading-tight text-muted-foreground">
            <span className="kpi-num">{row.windowLabel}</span>
          </p>

          {/* Line 3: Cutoff time / remaining cutoff countdown */}
          <p className="mt-0.5 truncate text-[10px] font-medium leading-tight text-muted-foreground/80">
            {row.locked || row.cutoffLeftMs <= 0 ? (
              <span className="kpi-num opacity-70">Cutoff passed</span>
            ) : (
              <span className="kpi-num text-primary/80">Cutoff · {countdownLabel(row.cutoffLeftMs)}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state !== "NOT_AVAILABLE" && (
            <MealGuestStepper
              guests={row.guests}
              changeable={guestChangeable}
              mealName={row.name}
              onStep={(delta) => onGuestStep?.(row, delta)}
              onAdd={() => onAddGuest?.(row)}
            />
          )}
          {state === "ON_LEAVE" ? (
            <StatusBadge
              status="ON_LEAVE"
              label="Leave"
              icon={Plane}
            />
          ) : state === "NOT_AVAILABLE" ? (
            <StatusBadge status="NOT_AVAILABLE" label={row.notAvailableLabel ?? "Not available"} />
          ) : (
            <GlassToggle
              checked={state === "ON"}
              disabled={row.locked || row.overridden}
              onChange={(next) => onToggle(row, next ? "ON" : "OFF")}
              label={row.toggleLabel}
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {(flash || guestFlash) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3">
              <FormNotice tone={flash?.tone === "info" || guestFlash?.tone === "info" ? "info" : (flash ?? guestFlash)!.tone}>
                {(flash ?? guestFlash)!.text}
              </FormNotice>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ----------------------------- agenda day section --------------------------- */

/**
 * The agenda day card: circular gradient date disc, day title, status chips,
 * rotating chevron and collapsible meal rows. `isToday` pops the disc in the
 * primary gradient; every other day renders a glass-inset disc. Each meal
 * row carries its own guest stepper (guests are part of the meal-row flow);
 * the day header keeps a guests chip with the day's guest total (guests are
 * NEVER counted in the ON/OFF/locked chips).
 */
export function AgendaDaySection({
  dateKey,
  isToday,
  title,
  rows,
  guests,
  expanded,
  onToggleExpand,
  flash,
  guestFlash,
  onToggleMeal,
  onGuestStep,
  onAddGuest,
}: {
  dateKey: string;
  isToday: boolean;
  title?: string;
  rows: AgendaMealRowVm[];
  /** The day's guest meal requests (non-cancelled) — header chip total. */
  guests?: AgendaGuestMealVm[];
  expanded: boolean;
  onToggleExpand: () => void;
  flash?: Record<string, Flash>;
  /** Inline guest-stepper flashes keyed by instance id. */
  guestFlash?: Record<string, Flash>;
  onToggleMeal: (row: AgendaMealRowVm, next: "ON" | "OFF") => void;
  onGuestStep?: (row: AgendaMealRowVm, delta: 1 | -1) => void;
  onAddGuest?: (row: AgendaMealRowVm) => void;
}) {
  const onCount = rows.filter((r) => r.state === "ON").length;
  const offCount = rows.filter((r) => r.state === "OFF").length;
  const leaveCount = rows.filter((r) => r.state === "ON_LEAVE").length;
  const lockedCount = rows.filter((r) => r.locked && r.state === "ON").length;
  const adminCount = rows.filter((r) => r.overridden).length;
  const guestTotal = (guests ?? []).reduce((s, g) => s + g.quantity, 0);
  const guestAdminOverrideTotal = rows.reduce((s, r) => s + (r.guestOverrideCount ?? 0), 0);

  return (
    <GlassCard className="overflow-hidden border border-border/40 hover:border-border/60 transition-colors">
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className={cn(
          "flex w-full cursor-pointer items-center gap-3 p-3.5 text-left transition-colors hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04]",
          expanded && "border-b border-border/25"
        )}
      >
        {/* Date badge — size-9 rounded-xl to match admin meals resident avatar */}
        <div
          className={cn(
            "flex size-9 shrink-0 flex-col items-center justify-center rounded-xl text-xs font-semibold",
            isToday
              ? "bg-gradient-to-br from-primary/80 to-primary text-primary-foreground shadow-sm"
              : "glass-inset text-primary"
          )}
        >
          <span className="text-[9px] font-bold uppercase leading-none tracking-tight">
            {weekdayShort(dateKey)}
          </span>
          <span
            className={cn(
              "mt-0.5 text-xs font-bold leading-none kpi-num",
              isToday ? "text-primary-foreground" : "text-foreground"
            )}
          >
            {dayNum(dateKey)}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", isToday && "font-semibold text-primary")}>
            {title ?? (isToday ? "Today" : longDayLabel(dateKey))}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
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
            {guestTotal > 0 && (
              <MiniChip tone="primary" icon={Users}>
                {guestTotal} {guestTotal === 1 ? "guest" : "guests"}
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
            {rows.length === 0 && (
              <span className="text-[11px] text-muted-foreground">No meals scheduled</span>
            )}
          </div>
        </div>

        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex shrink-0 items-center text-muted-foreground"
        >
          <ChevronDown className="size-4" aria-hidden />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 p-3 sm:p-3.5">
              {rows.map((row) => (
                <AgendaMealRow
                  key={row.id}
                  row={row}
                  flash={flash?.[row.id]}
                  guestFlash={guestFlash?.[row.id]}
                  onToggle={onToggleMeal}
                  onGuestStep={onGuestStep}
                  onAddGuest={onAddGuest}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
