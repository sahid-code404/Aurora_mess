"use client";

/**
 * Resident Meals (#/app/meals) — THE core screen, BoardOps layout.
 * Month agenda with collapsible day rows, month calendar grid, and a
 * single-day view — all driven by one centered picker pill (BoardOps
 * user-meals-view pattern). The agenda days AND the Day view render the
 * SAME shared AgendaDaySection (agenda-day.tsx), so a day looks identical
 * everywhere. The day's GUEST meals render as the FIRST row of every day
 * section with a ± stepper — self-service under cutoff, no admin permission
 * (add via dialog, remove/adjust inline). Optimistic ON/OFF toggles with
 * spring rollback + inline plain-language messages (spec §114), guest meal
 * and leave dialogs (spec §153/§154) kept from the original build.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  Calendar,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  List,
  Lock,
  Plane,
  RotateCcw,
  Sun,
  UserPlus,
  Users,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { useApiQuery } from "@/hooks/use-api-query";
import GlassCard from "@/components/glass/GlassCard";
import { KpiCard } from "@/components/glass/KpiCard";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import StatusBadge from "@/components/glass/StatusBadge";
import { GlassButton } from "@/components/glass/GlassButton";
import SectionHeading from "@/components/glass/SectionHeading";
import { EmptyState } from "@/components/glass/EmptyState";
import { ErrorState } from "@/components/glass/ErrorState";
import { ListSkeleton, KpiGridSkeleton } from "@/components/glass/LoadingSkeleton";

import {
  AgendaDaySection,
  agendaGuestRows,
  agendaRowFromInstance,
  dayNum,
  longDayLabel,
  parseKey,
  weekdayShort,
  type AgendaMealRowVm,
  type Flash,
} from "./_shared/agenda-day";
import { pickGuestStepTarget, stepGuestMeals } from "./_shared/guest-step";
import { useEnvelopeQuery, apiJson, useInvalidateResident, RESIDENT_KEYS } from "./_shared/api";
import { addDaysToKey, formatDateInTz, todayKeyInTz, friendlyError } from "./_shared/format";
import { useNow } from "./_shared/use-now";
import { GuestMealDialog, LeaveDialog } from "./_shared/guest-leave-dialogs";
import type { BillingData, GuestMealDto, LeaveRequestDto, MealInstanceDto, MealMyState, MealsMeta, ToggleResponse } from "./_shared/types";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";

/* ------------------------------ cache helpers ------------------------------ */

interface MealsCacheValue {
  data: MealInstanceDto[];
  meta: MealsMeta;
}

function patchCacheRows(
  value: MealsCacheValue | undefined,
  instanceId: string,
  patch: (m: MealInstanceDto) => MealInstanceDto
): MealsCacheValue | undefined {
  if (!value) return value;
  return { ...value, data: value.data.map((m) => (m.id === instanceId ? patch(m) : m)) };
}

/* ------------------------------- date helpers ------------------------------ */

/** (year, monthIndex 0-11) → "YYYY-MM". */
function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function monthStartKey(year: number, month: number): string {
  return `${monthKeyOf(year, month)}-01`;
}

function monthEndKey(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${monthKeyOf(year, month)}-${String(lastDay).padStart(2, "0")}`;
}

/** "September 2025". */
function monthLongLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month, 1))
  );
}

/** "Sep 2025" — compact KPI sub for non-current months. */
function monthShortKey(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month, 1))
  );
}

/** Picker pill labels — relative for ±1 day, compact otherwise (BoardOps pattern). */
function dayPillLabels(key: string, todayKey: string): { top: string; bottom: string } {
  if (key === todayKey) return { top: "Today", bottom: `${weekdayShort(key)}, ${formatDateInTz(key, "UTC")}` };
  if (key === addDaysToKey(todayKey, -1)) return { top: "Yesterday", bottom: `${weekdayShort(key)}, ${formatDateInTz(key, "UTC")}` };
  if (key === addDaysToKey(todayKey, 1)) return { top: "Tomorrow", bottom: `${weekdayShort(key)}, ${formatDateInTz(key, "UTC")}` };
  return { top: formatDateInTz(key, "UTC"), bottom: weekdayShort(key) };
}

const WEEKDAYS_SUN_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ------------------------------ circular arrow ----------------------------- */

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

/* --------------------------------- the view -------------------------------- */

type ViewMode = "agenda" | "calendar" | "day";

const VIEW_OPTIONS: { value: ViewMode; label: string; icon: LucideIcon }[] = [
  { value: "agenda", label: "Agenda", icon: List },
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "day", label: "Day", icon: Sun },
];

export default function ResidentMeals() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const clientToday = todayKeyInTz(tz);

  const queryClient = useQueryClient();
  const invalidate = useInvalidateResident();

  const now0 = new Date();
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("boardops_meals_view_mode");
      if (saved === "agenda" || saved === "calendar" || saved === "day") return saved as ViewMode;
    }
    return "agenda";
  });

  const [prevView, setPrevView] = useState(view);
  const isViewChange = view !== prevView;
  if (isViewChange) {
    setPrevView(view);
  }

  const [selMonth, setSelMonth] = useState(now0.getMonth());
  const [selYear, setSelYear] = useState(now0.getFullYear());
  const [dayKey, setDayKey] = useState(clientToday);
  const [dayExpanded, setDayExpanded] = useState(true);
  const [lastDayKey, setLastDayKey] = useState(clientToday);
  const [expandedDay, setExpandedDay] = useState<string | null>(clientToday);
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestDialogDate, setGuestDialogDate] = useState<string | undefined>(undefined);
  const [guestDialogInstance, setGuestDialogInstance] = useState<string | undefined>(undefined);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [flash, setFlash] = useState<Record<string, Flash>>({});
  const flashTimers = useRef<Record<string, number>>({});
  const [guestFlash, setGuestFlash] = useState<Record<string, Flash>>({});
  const guestFlashTimers = useRef<Record<string, number>>({});

  const from = monthStartKey(selYear, selMonth);
  const to = monthEndKey(selYear, selMonth);
  const isThisMonth = monthKeyOf(selYear, selMonth) === clientToday.slice(0, 7);

  const mealsQuery = useEnvelopeQuery<MealInstanceDto[], MealsMeta>("/api/v1/meals", { from, to });
  // Guest requests for the SAME range as the meal calendar (default ±7d was
  // too narrow — guests on any visible day must render in its day section).
  const guestQuery = useEnvelopeQuery<GuestMealDto[]>("/api/v1/guest-meals", { from, to });
  const billingQuery = useApiQuery<BillingData>("/api/v1/billing", undefined, { staleTime: 60_000 });
  const leaveQuery = useApiQuery<LeaveRequestDto[]>("/api/v1/leave-requests");

  const meta = mealsQuery.data?.meta;
  const serverNow = useNow(meta?.serverTime ?? null, 10_000);
  const todayKey = meta?.today ?? clientToday;

  // A freshly picked day always opens expanded (same as the agenda's Today).
  // Official "adjust state during render" pattern — no effect needed.
  if (lastDayKey !== dayKey) {
    setLastDayKey(dayKey);
    setDayExpanded(true);
  }

  useEffect(() => {
    return () => {
      for (const t of Object.values(flashTimers.current)) window.clearTimeout(t);
      for (const t of Object.values(guestFlashTimers.current)) window.clearTimeout(t);
    };
  }, []);

  function flashFor(instanceId: string, message: Flash) {
    setFlash((f) => ({ ...f, [instanceId]: message }));
    if (flashTimers.current[instanceId]) window.clearTimeout(flashTimers.current[instanceId]);
    flashTimers.current[instanceId] = window.setTimeout(() => {
      setFlash((f) => {
        const next = { ...f };
        delete next[instanceId];
        return next;
      });
    }, 6_500);
  }

  function flashGuestFor(instanceId: string, message: Flash) {
    setGuestFlash((f) => ({ ...f, [instanceId]: message }));
    if (guestFlashTimers.current[instanceId]) window.clearTimeout(guestFlashTimers.current[instanceId]);
    guestFlashTimers.current[instanceId] = window.setTimeout(() => {
      setGuestFlash((f) => {
        const next = { ...f };
        delete next[instanceId];
        return next;
      });
    }, 6_500);
  }

  /* --------------------------- optimistic toggle --------------------------- */

  async function handleToggle(meal: MealInstanceDto, next: "ON" | "OFF") {
    const queries = queryClient.getQueriesData<MealsCacheValue>({
      queryKey: ["api", "/api/v1/meals"],
    });
    const snapshots = queries.map(([key, value]) => ({ key, value }));

    let current: MealInstanceDto | undefined;
    for (const { value } of snapshots) {
      current = value?.data.find((m) => m.id === meal.id);
      if (current) break;
    }
    if (!current) return;

    const expectedVersion = current.myState.version;

    // Optimistically flip every cached copy of this row.
    for (const { key } of snapshots) {
      queryClient.setQueryData<MealsCacheValue>(key, (old) =>
        patchCacheRows(old, meal.id, (m) => ({
          ...m,
          myState: { ...m.myState, effectiveState: next } as MealMyState,
        }))
      );
    }

    try {
      const res = await apiJson<ToggleResponse>(`/api/v1/meals/${meal.id}/toggle`, "POST", {
        state: next,
        expectedVersion,
      });
      // Authoritative response wins.
      for (const { key } of snapshots) {
        queryClient.setQueryData<MealsCacheValue>(key, (old) =>
          patchCacheRows(old, meal.id, (m) => ({
            ...m,
            myState: {
              ...m.myState,
              effectiveState: res.state,
              effectiveReason: res.effectiveReason,
              locked: res.locked,
              version: res.version,
            } as MealMyState,
          }))
        );
      }
      invalidate([RESIDENT_KEYS.dashboard]);
    } catch (err) {
      // Rollback — the toggle springs back (spec §114).
      for (const { key, value } of snapshots) {
        queryClient.setQueryData<MealsCacheValue>(key, value);
      }
      if (err instanceof ApiClientError) {
        if (err.code === "MEAL_CUTOFF_PASSED") {
          flashFor(meal.id, {
            tone: "warning",
            text: `${meal.name} is already locked. Admin can still override it.`,
          });
        } else if (err.code === "RESOURCE_CHANGED") {
          flashFor(meal.id, { tone: "info", text: "This meal was just changed. Refreshing…" });
          void queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/meals"] });
        } else if (err.code === "MEAL_NOT_AVAILABLE") {
          flashFor(meal.id, { tone: "warning", text: "This meal isn't available to change right now." });
        } else {
          flashFor(meal.id, { tone: "danger", text: err.message });
        }
      } else {
        flashFor(meal.id, { tone: "danger", text: friendlyError(err) });
      }
    }
  }

  /* ------------------------------- grouping -------------------------------- */

  const meals = mealsQuery.data?.data ?? [];

  const groups = useMemo(() => {
    const byDate = new Map<string, MealInstanceDto[]>();
    for (const m of meals) {
      const list = byDate.get(m.serviceDate) ?? [];
      list.push(m);
      byDate.set(m.serviceDate, list);
    }
    return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [meals]);

  const dayMap = useMemo(() => new Map(groups), [groups]);

  const guestsByInstance = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of guestQuery.data?.data ?? []) {
      if (g.status === "CANCELLED") continue;
      map.set(g.mealInstanceId, (map.get(g.mealInstanceId) ?? 0) + g.quantity);
    }
    return map;
  }, [guestQuery.data]);

  const guestOverrideByInstance = useMemo(() => {
    const map = new Map<string, { overridden: boolean; count: number }>();
    const allGuests = guestQuery.data?.data ?? [];
    // Group active guests by instance to get current totals
    const activeByInstance = new Map<string, number>();
    for (const g of allGuests) {
      if (g.status === "CANCELLED") continue;
      activeByInstance.set(g.mealInstanceId, (activeByInstance.get(g.mealInstanceId) ?? 0) + g.quantity);
    }
    // Check override notes for each guest request
    for (const g of allGuests) {
      if (map.has(g.mealInstanceId)) continue; // already determined
      const origMatch = g.note?.match(/Admin override\|orig:(\d+)/);
      if (origMatch) {
        const originalBaseline = parseInt(origMatch[1], 10);
        const currentTotal = activeByInstance.get(g.mealInstanceId) ?? 0;
        const delta = Math.abs(currentTotal - originalBaseline);
        map.set(g.mealInstanceId, { overridden: delta > 0, count: delta });
      } else if (g.note?.startsWith("Admin override") || g.note === "Admin override") {
        // Backward compat: old format without baseline
        const currentTotal = activeByInstance.get(g.mealInstanceId) ?? 0;
        map.set(g.mealInstanceId, { overridden: true, count: currentTotal });
      }
    }
    return map;
  }, [guestQuery.data]);

  /* ------------------------------ guest meals ------------------------------- */

  /** Active guest requests grouped per day (CANCELLED excluded). */
  const activeGuests = useMemo(
    () => (guestQuery.data?.data ?? []).filter((g) => g.status !== "CANCELLED"),
    [guestQuery.data]
  );
  const guestsByDate = useMemo(() => {
    const map = new Map<string, GuestMealDto[]>();
    for (const g of activeGuests) {
      const list = map.get(g.serviceDate) ?? [];
      list.push(g);
      map.set(g.serviceDate, list);
    }
    return map;
  }, [activeGuests]);

  /** Total guest meals for the visible scope (month, or the picked day). */
  const monthGuestTotal = useMemo(() => activeGuests.reduce((s, g) => s + g.quantity, 0), [activeGuests]);

  /** Open the add-guests dialog (optionally pre-set to one meal instance). */
  function openGuestDialog(dateKey?: string, instanceId?: string) {
    setGuestDialogDate(dateKey);
    setGuestDialogInstance(instanceId);
    setGuestOpen(true);
  }

  /**
   * Adjust ONE MEAL's guest count with its row stepper — self-service under
   * cutoff, no admin permission (guest meals behave like normal meals in the
   * user flow). Optimistic patch of every cached guest list copy with rollback
   * and a plain-language flash, exactly like the meal toggles (spec §114).
   * "+1" with no request for that meal opens the guest dialog pre-selected
   * to the meal (a quantity note may be needed).
   */
  async function handleGuestStep(row: AgendaMealRowVm, delta: 1 | -1) {
    const inst = meals.find((m) => m.id === row.id);
    if (!inst) return;
    const dayGuests = guestsByDate.get(inst.serviceDate) ?? [];
    const instanceGuests = dayGuests.filter((g) => g.mealInstanceId === inst.id);
    const queries = queryClient.getQueriesData<{ data: GuestMealDto[]; meta: unknown }>({
      queryKey: ["api", "/api/v1/guest-meals"],
    });
    const snapshots = queries.map(([key, value]) => ({ key, value }));

    // Optimistic: apply the same target pick locally (this meal's requests only).
    const target = pickGuestStepTarget(instanceGuests, delta, serverNow);
    if (target) {
      const nextQty = delta === 1 ? target.quantity + 1 : target.quantity - 1;
      for (const { key } of snapshots) {
        queryClient.setQueryData<{ data: GuestMealDto[]; meta: unknown }>(key, (old) =>
          old
            ? {
                ...old,
                data: old.data.map((g) =>
                  g.id !== target.id
                    ? g
                    : nextQty <= 0
                      ? { ...g, status: "CANCELLED" }
                      : { ...g, quantity: nextQty, totalPriceMinor: g.unitPriceMinor * nextQty }
                ),
              }
            : old
        );
      }
    }

    const result = await stepGuestMeals(instanceGuests, delta, serverNow);
    if (result.kind === "ok") {
      invalidate([RESIDENT_KEYS.guestMeals, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.billing, RESIDENT_KEYS.notifications]);
    } else if (result.kind === "dialog") {
      // No request for this meal can absorb the +1 — the dialog takes over,
      // pre-selected to the meal the user tapped.
      for (const { key, value } of snapshots) queryClient.setQueryData(key, value);
      openGuestDialog(inst.serviceDate, inst.id);
    } else {
      // Rollback — the counter springs back.
      for (const { key, value } of snapshots) queryClient.setQueryData(key, value);
      if (result.code === "RESOURCE_CHANGED") {
        flashGuestFor(inst.id, { tone: "info", text: "This guest meal was just changed. Refreshing…" });
        void queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/guest-meals"] });
      } else if (result.code === "MEAL_CUTOFF_PASSED") {
        flashGuestFor(inst.id, {
          tone: "warning",
          text: `${inst.name} is locked — the cutoff already passed.`,
        });
      } else {
        flashGuestFor(inst.id, { tone: "danger", text: result.message });
      }
    }
  }

  const stats = useMemo(() => {
    let on = 0;
    let off = 0;
    let locked = 0;
    for (const m of meals) {
      if (m.myState.effectiveState === "ON") on++;
      else if (m.myState.effectiveState === "OFF") off++;
      if (m.myState.locked && m.myState.effectiveState === "ON") locked++;
    }
    return { on, off, locked };
  }, [meals]);

  const dayMeals = useMemo(
    () =>
      meals
        .filter((m) => m.serviceDate === dayKey)
        .sort((a, b) => (a.cutoffAt < b.cutoffAt ? -1 : 1)),
    [meals, dayKey]
  );

  const dayStats = useMemo(() => {
    let on = 0;
    let off = 0;
    let locked = 0;
    for (const m of dayMeals) {
      if (m.myState.effectiveState === "ON") on++;
      else if (m.myState.effectiveState === "OFF") off++;
      if (m.myState.locked && m.myState.effectiveState === "ON") locked++;
    }
    return { on, off, locked };
  }, [dayMeals]);

  // Auto-scroll to TODAY once, after the first data load (agenda only).
  const scrolledRef = useRef(false);
  const todayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrolledRef.current || view !== "agenda" || mealsQuery.isPending) return;
    if (!dayMap.has(todayKey)) return;
    scrolledRef.current = true;
    const t = window.setTimeout(() => {
      todayRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    return () => window.clearTimeout(t);
  }, [view, mealsQuery.isPending, dayMap, todayKey]);

  /* ------------------------------ month nav -------------------------------- */

  function shiftMonth(delta: number) {
    const d = new Date(Date.UTC(selYear, selMonth + delta, 1));
    setSelMonth(d.getUTCMonth());
    setSelYear(d.getUTCFullYear());
    const start = monthStartKey(d.getUTCFullYear(), d.getUTCMonth());
    const end = monthEndKey(d.getUTCFullYear(), d.getUTCMonth());
    setDayKey((k) => (k >= start && k <= end ? k : clientToday >= start && clientToday <= end ? clientToday : start));
    setExpandedDay(null);
  }

  function resetToCurrentMonth() {
    if (isThisMonth) return;
    const [y, m] = clientToday.split("-").map(Number);
    setSelYear(y);
    setSelMonth(m - 1);
    setDayKey(clientToday);
    setExpandedDay(clientToday);
  }

  function switchView(next: ViewMode) {
    setView(next);
    if (typeof window !== "undefined") {
      localStorage.setItem("boardops_meals_view_mode", next);
    }
    if (next === "day" && (dayKey < from || dayKey > to)) {
      setDayKey(clientToday >= from && clientToday <= to ? clientToday : from);
    }
    if (next === "agenda" && !expandedDay) {
      setExpandedDay(dayMap.has(todayKey) ? todayKey : null);
    }
  }

  const guestPriceMinor = billingQuery.data?.guestPriceMinor ?? null;

  /* --------------------------------- render --------------------------------- */

  if (mealsQuery.isPending) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <div className="glass-skeleton size-10 rounded-pill" />
          <div className="glass-skeleton h-12 w-full max-w-[280px] rounded-pill" />
          <div className="glass-skeleton size-10 rounded-pill" />
        </div>
        <KpiGridSkeleton count={3} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (mealsQuery.isError || !mealsQuery.data) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={mealsQuery.error?.code}
          message={mealsQuery.error?.message}
          onRetry={() => void mealsQuery.refetch()}
        />
      </div>
    );
  }

  const leaves = leaveQuery.data ?? [];
  const viewStats = view === "day" ? dayStats : stats;
  // Guest KPI scope mirrors the view: the picked day in Day view, else month.
  const dayGuestTotal = (guestsByDate.get(dayKey) ?? []).reduce((s, g) => s + g.quantity, 0);
  const viewGuests = view === "day" ? dayGuestTotal : monthGuestTotal;
  const dayPill = dayPillLabels(dayKey, todayKey);
  const kpiSub = view === "day" ? dayPill.bottom : isThisMonth ? "This month" : monthShortKey(selYear, selMonth);

  return (
    <StaggerGroup className="space-y-4">
      {/* Picker — month for agenda/calendar, day for the day view */}
      <StaggerItem>
      {view === "day" ? (
        <div className="flex items-center justify-center gap-3 sm:gap-4">
          <CircleArrow
            direction="prev"
            label="Previous day"
            disabled={dayKey <= from}
            onClick={() => setDayKey((k) => (k > from ? addDaysToKey(k, -1) : k))}
          />
          <button
            type="button"
            onClick={() => {
              if (dayKey !== todayKey) {
                if (todayKey >= from && todayKey <= to) setDayKey(todayKey);
                else resetToCurrentMonth();
              }
            }}
            className="glass flex min-w-0 max-w-[280px] flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-pill px-4 py-2.5 transition-all hover:ring-1 hover:ring-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-6"
          >
            <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 text-center leading-tight">
              <span className="block truncate text-sm font-bold text-primary">{dayPill.top}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{dayPill.bottom}</span>
            </span>
            {dayKey !== todayKey && <RotateCcw className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          </button>
          <CircleArrow
            direction="next"
            label="Next day"
            disabled={dayKey >= to}
            onClick={() => setDayKey((k) => (k < to ? addDaysToKey(k, 1) : k))}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 sm:gap-4">
          <CircleArrow direction="prev" label="Previous month" onClick={() => shiftMonth(-1)} />
          <button
            type="button"
            onClick={resetToCurrentMonth}
            className="glass flex min-w-0 max-w-[280px] flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-pill px-4 py-2.5 transition-all hover:ring-1 hover:ring-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-6"
          >
            <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 text-center leading-tight">
              <span className="block truncate text-sm font-bold text-primary">
                {monthLongLabel(selYear, selMonth).split(" ")[0]}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">{selYear}</span>
            </span>
            {!isThisMonth && <RotateCcw className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          </button>
          <CircleArrow direction="next" label="Next month" onClick={() => shiftMonth(1)} />
        </div>
      )}
      </StaggerItem>

      {/* KPI cards — guests are NOT normal meals: never in the ON/OFF/Locked
          counts; they get their own KPI (was "Meals OFF"). */}
      <StaggerItem>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <KpiCard label="ON" value={String(viewStats.on)} sub={kpiSub} icon={<Check />} glow="success" tone="success" index={0} />
        <KpiCard label="Guests" value={String(viewGuests)} sub={kpiSub} icon={<Users />} glow="primary" tone="primary" index={1} />
        <KpiCard label="Locked" value={String(viewStats.locked)} sub="Past cutoff" icon={<Lock />} glow="danger" tone="danger" index={2} />
      </div>
      </StaggerItem>

      {/* View switch + actions */}
      <StaggerItem>
      <div className="flex flex-col items-center justify-center gap-2.5">
        {/* Row 1: Persisted View Selector Bar */}
        <LayoutGroup id="resident-meals-view-group">
          <div
            role="radiogroup"
            aria-label="Meals view"
            className="glass-inset hover:glass border border-border/40 inline-flex items-center gap-1 rounded-full p-1 shadow-sm transition-all"
          >
            {VIEW_OPTIONS.map((opt) => {
              const active = view === opt.value;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => switchView(opt.value)}
                  className={cn(
                    "relative inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-full px-4 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    active ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground/90"
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="meals-view-pill"
                      layoutDependency={view}
                      initial={false}
                      className="absolute inset-0 rounded-full border border-border/60 bg-foreground/10 dark:bg-white/10 shadow-sm"
                      transition={!isViewChange ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 38 }}
                    />
                  )}
                  <Icon className="relative z-10 size-3.5" aria-hidden />
                  <span className="relative z-10">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>

        {/* Row 2 (Below): Action Buttons with identical pill design & outer border */}
        <div className="flex items-center justify-center gap-2">
          <motion.button
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => openGuestDialog()}
            className="glass-inset hover:glass border border-border/40 hover:border-border/70 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[12px] font-medium text-foreground transition-all hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring shadow-sm"
          >
            <UserPlus className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span>Guest meal</span>
          </motion.button>
          <motion.button
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setLeaveOpen(true)}
            className="glass-inset hover:glass border border-border/40 hover:border-border/70 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[12px] font-medium text-foreground transition-all hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring shadow-sm"
          >
            <Plane className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span>Apply for leave</span>
          </motion.button>
        </div>
      </div>
      </StaggerItem>

      {/* Content — agenda / calendar / day */}
      <StaggerItem>
      {view === "agenda" && (
        <div className="space-y-2">
          {groups.length === 0 ? (
            <EmptyState
              icon={Utensils}
              title={`No meals scheduled for ${monthLongLabel(selYear, selMonth)}`}
              description="Your mess hasn't published meal times for this month. Check back soon."
            />
          ) : (
            <AnimatePresence initial={false} mode="popLayout">
              {groups.map(([date, dayList]) => (
                <motion.div
                  key={date}
                  ref={date === todayKey ? todayRef : undefined}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={SPRING_SNAPPY}
                >
                  <AgendaDaySection
                    dateKey={date}
                    isToday={date === todayKey}
                    rows={dayList.map((m) =>
                      agendaRowFromInstance(
                        m,
                        tz,
                        serverNow,
                        guestsByInstance.get(m.id) ?? 0,
                        guestOverrideByInstance.get(m.id)?.overridden ?? false,
                        guestOverrideByInstance.get(m.id)?.count ?? 0
                      )
                    )}
                    guests={agendaGuestRows(guestsByDate.get(date) ?? [], serverNow)}
                    expanded={expandedDay === date}
                    onToggleExpand={() => setExpandedDay((prev) => (prev === date ? null : date))}
                    flash={flash}
                    guestFlash={guestFlash}
                    onToggleMeal={(row, next) => {
                      const inst = meals.find((m) => m.id === row.id);
                      if (inst) void handleToggle(inst, next);
                    }}
                    onGuestStep={(row, delta) => void handleGuestStep(row, delta)}
                    onAddGuest={(row) => openGuestDialog(date, row.id)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>
      )}

      {view === "calendar" && (
        <GlassCard className="p-4 sm:p-5 border border-border/40">
          {/* Weekday headers (Sun-first) */}
          <div className="mb-2 grid grid-cols-7 gap-1">
            {WEEKDAYS_SUN_FIRST.map((wd) => (
              <div key={wd} className="py-1 text-center text-[10px] font-medium text-muted-foreground">
                {wd}
              </div>
            ))}
          </div>
          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-1">
            {(() => {
              const startJsDay = parseKey(from).getUTCDay();
              const lastDay = parseKey(to).getUTCDate();
              const cells: (string | null)[] = [];
              for (let i = 0; i < startJsDay; i++) cells.push(null);
              for (let d = 1; d <= lastDay; d++) {
                cells.push(`${monthKeyOf(selYear, selMonth)}-${String(d).padStart(2, "0")}`);
              }
              while (cells.length % 7 !== 0) cells.push(null);

              return cells.map((key, i) => {
                if (!key) return <div key={`pad-${i}`} className="aspect-square min-h-[44px]" />;
                const entries = dayMap.get(key) ?? [];
                const dayGuests = guestsByDate.get(key) ?? [];
                const guestCount = dayGuests.reduce((s, g) => s + g.quantity, 0);
                const isToday = key === todayKey;
                const isPast = key < todayKey;
                const onCount = entries.filter((m) => m.myState.effectiveState === "ON").length;
                const offCount = entries.filter((m) => m.myState.effectiveState === "OFF").length;
                const hasLocked = entries.some((m) => m.myState.locked && m.myState.effectiveState === "ON");

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setDayKey(key);
                      switchView("day");
                    }}
                    aria-label={`${longDayLabel(key)}${entries.length ? `, ${entries.length} meals` : ", no meals"}`}
                    className={cn(
                      "relative flex aspect-square min-h-[44px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                      isToday
                        ? "bg-primary/15 ring-1 ring-primary/40"
                        : entries.length > 0
                          ? "glass-inset hover:ring-1 hover:ring-primary/30"
                          : "opacity-40 hover:opacity-70",
                      !isToday && isPast && "opacity-60"
                    )}
                  >
                    <span className={cn("font-bold", isToday ? "text-primary" : "text-foreground")}>{dayNum(key)}</span>
                    {(entries.length > 0 || guestCount > 0) && (
                      <span className="flex items-center gap-0.5">
                        {onCount > 0 && <span className="size-1.5 rounded-full bg-success" />}
                        {offCount > 0 && <span className="size-1.5 rounded-full bg-warning" />}
                        {hasLocked && <span className="size-1.5 rounded-full bg-danger" />}
                        {guestCount > 0 && <span className="size-1.5 rounded-full bg-primary" />}
                      </span>
                    )}
                  </button>
                );
              });
            })()}
          </div>
          {/* Legend */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-4 border-t border-border/40 pt-3">
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" /> ON
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-warning" /> OFF
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-danger" /> Locked
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-primary" /> Guests
            </span>
          </div>
        </GlassCard>
      )}

      {view === "day" && (
        <div className="space-y-3">
          {dayMeals.length === 0 ? (
            <EmptyState
              icon={Utensils}
              title="No meals on this date"
              description={
                dayKey < todayKey
                  ? "No meal records for this past date."
                  : "The kitchen hasn't published meals for this date yet — try another day."
              }
            />
          ) : (
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={dayKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={SPRING_SNAPPY}
              >
                {/* The Day view is the agenda's day section for the picked date. */}
                <AgendaDaySection
                  dateKey={dayKey}
                  isToday={dayKey === todayKey}
                  rows={dayMeals.map((m) =>
                    agendaRowFromInstance(
                      m,
                      tz,
                      serverNow,
                      guestsByInstance.get(m.id) ?? 0,
                      guestOverrideByInstance.get(m.id)?.overridden ?? false,
                      guestOverrideByInstance.get(m.id)?.count ?? 0
                    )
                  )}
                  guests={agendaGuestRows(guestsByDate.get(dayKey) ?? [], serverNow)}
                  expanded={dayExpanded}
                  onToggleExpand={() => setDayExpanded((e) => !e)}
                  flash={flash}
                  guestFlash={guestFlash}
                  onToggleMeal={(row, next) => {
                    const inst = dayMeals.find((m) => m.id === row.id);
                    if (inst) void handleToggle(inst, next);
                  }}
                  onGuestStep={(row, delta) => void handleGuestStep(row, delta)}
                  onAddGuest={(row) => openGuestDialog(dayKey, row.id)}
                />
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      )}
      </StaggerItem>

      {/* My leave requests */}
      <StaggerItem>
      <GlassCard className="p-4 sm:p-5" aria-label="My leave requests">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Plane className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">My leave requests</h3>
          {leaves.length > 0 && (
            <span className="kpi-num text-xs text-muted-foreground">
              · {leaves.length} request{leaves.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">Leave history</span>
        </div>

        {leaveQuery.isPending ? (
          <ListSkeleton rows={2} />
        ) : leaves.length === 0 ? (
          <EmptyState
            icon={Plane}
            title="No leave requests yet"
            description="Going out of town? Apply for leave and your meals turn off while you're away."
          />
        ) : (
          <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">
            {leaves.map((l) => (
              <div key={l.id} className="glass-inset hover:glass border border-border/40 rounded-2xl p-3.5 transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="kpi-num text-sm font-semibold text-foreground">
                      {l.startDate} → {l.endDate}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{l.reason}</p>
                  </div>
                  <StatusBadge status={l.status} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {l.preview.futureUnlockedMeals} future unlocked meals will turn off
                  {l.preview.alreadyLockedMeals > 0
                    ? `; ${l.preview.alreadyLockedMeals} locked meals stay unchanged`
                    : ""}
                  .
                </p>
                {l.status === "REJECTED" && l.reviewReason && (
                  <p className="mt-1 text-xs font-medium text-danger">Reason: {l.reviewReason}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      <GuestMealDialog
        open={guestOpen}
        onOpenChange={(next) => {
          setGuestOpen(next);
          if (!next) {
            setGuestDialogDate(undefined);
            setGuestDialogInstance(undefined);
          }
        }}
        tz={tz}
        todayKey={todayKey}
        guestPriceMinor={guestPriceMinor}
        initialDate={guestDialogDate}
        initialInstanceId={guestDialogInstance}
      />
      <LeaveDialog open={leaveOpen} onOpenChange={setLeaveOpen} todayKey={todayKey} />
    </StaggerGroup>
  );
}
