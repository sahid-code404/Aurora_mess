"use client";

/**
 * Resident Dashboard (#/app/dashboard) — Task 5-b.
 * GET /api/v1/me/dashboard → greeting, 4 KPIs, today's meals rendered as the
 * agenda current-day view (shared AgendaDaySection — same day card as the
 * meals page) with the day's GUEST meals as the FIRST row (self-service ±
 * stepper under cutoff — no admin permission, never counted as normal
 * locked meals), recent activity as an Apple-style notification STACK
 * (first 5 rows always show; the rest fold behind with peek cards, spring
 * open on tap and physically slide while scrolling) and pinned
 * announcements.
 * Simple language only (spec §150-152, §158): "Amount to Pay", meal states
 * ON / OFF / LOCKED / Admin Override / On Leave / Not Available.
 * Liquid Glass II: hero greeting panel, staggered KPI grid, animated lists.
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  FileText,
  Megaphone,
  Utensils,
  Wallet,
} from "lucide-react";

import { useApiQuery } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { navigateTo } from "@/hooks/use-hash-route";
import GlassCard from "@/components/glass/GlassCard";
import { KpiCard } from "@/components/glass/KpiCard";
import StatusBadge from "@/components/glass/StatusBadge";
import { EmptyState } from "@/components/glass/EmptyState";
import { ErrorState } from "@/components/glass/ErrorState";
import { ListSkeleton, KpiGridSkeleton } from "@/components/glass/LoadingSkeleton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { gradientForName, getTimeGreeting } from "@/lib/gradients";
import { ApiClientError } from "@/lib/api";
import { getNotificationTargetRoute } from "@/lib/notification-routes";
import { cn } from "@/lib/utils";

import {
  AgendaDaySection,
  agendaGuestRows,
  agendaRowFromDashboard,
  type Flash,
} from "./_shared/agenda-day";
import { pickGuestStepTarget, stepGuestMeals } from "./_shared/guest-step";
import { GuestMealDialog } from "./_shared/guest-leave-dialogs";
import { firstNameOf, formatTimeInTz, friendlyError, todayKeyInTz, notificationIcon } from "./_shared/format";
import { useNow } from "./_shared/use-now";
import { apiJson, useInvalidateResident, RESIDENT_KEYS } from "./_shared/api";
import {
  isMoneyUsable,
  type BillingData,
  type DashboardData,
  type DashboardTodayGuest,
  type DashboardTodayMeal,
  type ToggleResponse,
} from "./_shared/types";


/** Tone-tinted icon orb for the activity stack (same palette as the
 * notifications page — danger / success / warning / primary). */
function activityTone(type: string): string {
  if (type.includes("REJECTED")) return "border-danger/30 bg-danger/12 text-danger";
  if (type.includes("APPROVED") || type.includes("ACCEPTED"))
    return "border-success/30 bg-success/12 text-success";
  if (type.includes("SUBMITTED") || type.includes("PENDING"))
    return "border-warning/30 bg-warning/14 text-warning";
  return "border-primary/28 bg-primary/12 text-primary";
}

/* ---------------------------------- view ----------------------------------- */

function DateTimePill({ timezone }: { timezone?: string | null }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const tz = timezone ?? "Asia/Kolkata";

  const fullDateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);

  const shortDateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);

  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const getTimePart = (t: string) => timeParts.find((p) => p.type === t)?.value ?? "";
  const timeLabel = `${getTimePart("hour")}:${getTimePart("minute")} ${getTimePart("dayPeriod").toUpperCase()}`;

  return (
    <div
      suppressHydrationWarning
      className="glass-inset flex items-center gap-2 rounded-pill px-3.5 py-2 text-xs font-medium sm:px-4 sm:py-2.5 sm:text-sm"
    >
      <CalendarClock className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="hidden sm:inline text-foreground">{fullDateLabel}</span>
      <span className="sm:hidden text-foreground">{shortDateLabel}</span>
      <span aria-hidden className="text-muted-foreground/60">·</span>
      <span className="kpi-num font-semibold text-primary">{timeLabel}</span>
    </div>
  );
}

export default function ResidentDashboard() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const reducedMotion = useReducedMotion();

  const queryClient = useQueryClient();
  const invalidate = useInvalidateResident();

  const query = useApiQuery<DashboardData>("/api/v1/me/dashboard");
  const now = useNow(null, 10_000);
  // Guest price fallback for the add-guests dialog (shared billing cache).
  const billingQuery = useApiQuery<BillingData>("/api/v1/billing", undefined, { staleTime: 60_000 });

  const [flash, setFlash] = useState<Record<string, Flash>>({});
  const flashTimers = useRef<Record<string, number>>({});
  const [todayExpanded, setTodayExpanded] = useState(true);
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestDialogDate, setGuestDialogDate] = useState<string | undefined>(undefined);
  const [guestDialogInstance, setGuestDialogInstance] = useState<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      for (const t of Object.values(flashTimers.current)) window.clearTimeout(t);
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
    }, 6_000);
  }

  /* ------------------------- optimistic meal toggle ------------------------- */

  /** Patch a today-meal row inside the dashboard cache. */
  function patchTodayMeal(
    old: DashboardData | undefined,
    mealId: string,
    patch: (m: DashboardTodayMeal) => DashboardTodayMeal
  ): DashboardData | undefined {
    if (!old) return old;
    return { ...old, todayMeals: old.todayMeals.map((m) => (m.id === mealId ? patch(m) : m)) };
  }

  async function handleToggle(meal: DashboardTodayMeal, next: "ON" | "OFF") {
    const key = ["api", "/api/v1/me/dashboard", {}] as const;
    const snapshot = queryClient.getQueryData<DashboardData>(key);
    const current = snapshot?.todayMeals.find((m) => m.id === meal.id);
    if (!current?.myVersion) return;
    const expectedVersion = current.myVersion;

    // Optimistic flip + KPI recount (spec §114 — spring rollback on failure).
    queryClient.setQueryData<DashboardData>(key, (old) => {
      const patched = patchTodayMeal(old, meal.id, (m) => ({ ...m, myState: next }));
      if (!patched || !old) return patched;
      const onCount = patched.todayMeals.filter((m) => m.myState === "ON").length;
      return { ...patched, kpis: { ...old.kpis, mealsToday: onCount } };
    });

    try {
      const res = await apiJson<ToggleResponse>(`/api/v1/meals/${meal.id}/toggle`, "POST", {
        state: next,
        expectedVersion,
      });
      // Authoritative response wins.
      queryClient.setQueryData<DashboardData>(key, (old) => {
        const patched = patchTodayMeal(old, meal.id, (m) => ({
          ...m,
          myState: res.state,
          myReason: res.effectiveReason,
          myVersion: res.version,
        }));
        if (!patched || !old) return patched;
        const onCount = patched.todayMeals.filter((m) => m.myState === "ON").length;
        return { ...patched, kpis: { ...old.kpis, mealsToday: onCount } };
      });
      // Keep the meals agenda in sync with this change.
      invalidate([RESIDENT_KEYS.meals]);
    } catch (err) {
      // Rollback — the toggle springs back.
      if (snapshot) queryClient.setQueryData<DashboardData>(key, snapshot);
      if (err instanceof ApiClientError) {
        if (err.code === "MEAL_CUTOFF_PASSED") {
          flashFor(meal.id, {
            tone: "warning",
            text: `${meal.mealName} is already locked. Admin can still override it.`,
          });
        } else if (err.code === "RESOURCE_CHANGED") {
          flashFor(meal.id, { tone: "info", text: "This meal was just changed. Refreshing…" });
          void queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/me/dashboard"] });
        } else {
          flashFor(meal.id, { tone: "danger", text: err.message });
        }
      } else {
        flashFor(meal.id, { tone: "danger", text: friendlyError(err) });
      }
    }
  }

  /* ----------------------- optimistic guest meal step ----------------------- */

  /** Patch a today-guest row inside the dashboard cache. */
  function patchTodayGuests(
    old: DashboardData | undefined,
    targetId: string,
    nextQty: number
  ): DashboardData | undefined {
    if (!old) return old;
    return {
      ...old,
      todayGuests:
        nextQty <= 0
          ? old.todayGuests.filter((g) => g.id !== targetId)
          : old.todayGuests.map((g) =>
              g.id === targetId ? { ...g, quantity: nextQty, totalPriceMinor: g.unitPriceMinor * nextQty } : g
            ),
    };
  }

  /** Adjust ONE MEAL's guest count from its row stepper — self-service under
   *  cutoff (spec: guests behave like normal meals in the user flow).
   *  Optimistic patch + rollback + flash. */
  async function handleGuestStep(instanceId: string, todayGuests: DashboardTodayGuest[], delta: 1 | -1) {
    const key = ["api", "/api/v1/me/dashboard", {}] as const;
    const snapshot = queryClient.getQueryData<DashboardData>(key);
    const instanceGuests = todayGuests.filter((g) => g.mealInstanceId === instanceId);

    // Optimistic: apply the same target pick locally (KPIs stay untouched —
    // guests are never counted as normal meals).
    const target = pickGuestStepTarget(instanceGuests, delta, now);
    if (target) {
      const nextQty = delta === 1 ? target.quantity + 1 : target.quantity - 1;
      queryClient.setQueryData<DashboardData>(key, (old) => patchTodayGuests(old, target.id, nextQty));
    }

    const result = await stepGuestMeals(instanceGuests, delta, now);
    if (result.kind === "ok") {
      invalidate([RESIDENT_KEYS.guestMeals, RESIDENT_KEYS.billing, RESIDENT_KEYS.notifications]);
    } else if (result.kind === "dialog") {
      // No request for this meal can absorb the +1 — the dialog takes over
      // (pre-selected to the tapped meal's date).
      if (snapshot) queryClient.setQueryData<DashboardData>(key, snapshot);
      setGuestOpen(true);
    } else {
      // Rollback — the counter springs back.
      if (snapshot) queryClient.setQueryData<DashboardData>(key, snapshot);
      if (result.code === "RESOURCE_CHANGED") {
        flashFor(instanceId, { tone: "info", text: "This guest meal was just changed. Refreshing…" });
        void queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/me/dashboard"] });
      } else if (result.code === "MEAL_CUTOFF_PASSED") {
        flashFor(instanceId, {
          tone: "warning",
          text: "This meal is locked — the cutoff already passed.",
        });
      } else {
        flashFor(instanceId, { tone: "danger", text: result.message });
      }
    }
  }

  const data = query.data;
  const firstName = data ? firstNameOf(data.greeting.fullName) : "";
  const nameGradient = data ? gradientForName(data.greeting.fullName) : "";
  const timeGreeting = getTimeGreeting();

  if (query.isPending) {
    return (
      <div className="space-y-4">
        <div className="glass-skeleton h-9 w-64" />
        <div className="glass-skeleton h-4 w-44" />
        <KpiGridSkeleton count={4} />
        <ListSkeleton rows={3} />
      </div>
    );
  }

  if (query.isError || !data) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={query.error?.code}
          message={query.error?.message}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const { kpis, todayMeals, todayGuests, recentActivity, pinnedAnnouncements } = data;
  const servicesCount = todayMeals.length;
  /** Guests per meal instance — each row carries its own stepper. */
  const guestsByInstance = new Map<string, number>();
  for (const g of todayGuests) {
    guestsByInstance.set(g.mealInstanceId, (guestsByInstance.get(g.mealInstanceId) ?? 0) + g.quantity);
  }

  const guestOverrideByInstance = new Map<string, { overridden: boolean; count: number }>();
  for (const g of todayGuests) {
    if (guestOverrideByInstance.has(g.mealInstanceId)) continue;
    const origMatch = g.note?.match(/Admin override\|orig:(\d+)/);
    if (origMatch) {
      const originalBaseline = parseInt(origMatch[1], 10);
      const currentTotal = guestsByInstance.get(g.mealInstanceId) ?? 0;
      const delta = Math.abs(currentTotal - originalBaseline);
      guestOverrideByInstance.set(g.mealInstanceId, { overridden: delta > 0, count: delta });
    } else if (g.note?.startsWith("Admin override") || g.note === "Admin override") {
      const currentTotal = guestsByInstance.get(g.mealInstanceId) ?? 0;
      guestOverrideByInstance.set(g.mealInstanceId, { overridden: true, count: currentTotal });
    }
  }

  const guestPriceMinor = billingQuery.data?.guestPriceMinor ?? null;

  return (
    <StaggerGroup className="space-y-4">
      {/* Hero greeting */}
      <StaggerItem>
      <GlassCard strong className="relative overflow-hidden p-5 sm:p-7">
        <span
          aria-hidden
          className={`pointer-events-none absolute -right-10 -top-10 size-44 rounded-full bg-gradient-to-br from-primary/25 via-gold/15 to-transparent blur-2xl ${reducedMotion ? "" : "float-y"}`}
        />
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="font-display text-[26px] font-bold leading-tight tracking-tight sm:text-[32px]">
              {timeGreeting.greeting}{", "}
              <span className={cn("bg-gradient-to-br bg-clip-text text-transparent", nameGradient)}>
                {firstName}
              </span>{" "}
              <span aria-hidden className="text-[26px] sm:text-[30px]">
                {timeGreeting.emoji}
              </span>
            </h1>
          </div>
          <div className="shrink-0">
            <DateTimePill timezone={tz} />
          </div>
        </div>
      </GlassCard>
      </StaggerItem>

      {/* Pinned announcements — placed directly after greeting without section title */}
      {pinnedAnnouncements.length > 0 && (
        <StaggerItem>
        <section aria-label="Pinned announcements" className="space-y-3">
          {pinnedAnnouncements.map((a) => (
            <GlassCard
              key={a.id}
              className="border-warning/25 p-4 sm:p-5"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-warning/30 bg-gradient-to-br from-warning/22 to-warning/6 text-warning shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_18px_-8px_color-mix(in_oklab,var(--warning)_55%,transparent)] [&_svg]:size-5"
                >
                  <Megaphone />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold">{a.title}</p>
                    {a.priority === "HIGH" && <StatusBadge status="GRACE" label="High priority" />}
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{a.message}</p>
                </div>
              </div>
            </GlassCard>
          ))}
        </section>
        </StaggerItem>
      )}

      {/* KPIs — BoardOps auto-fit grid; every card navigates */}
      <StaggerItem>
      <div className="grid-kpi gap-3">
        <KpiCard
          index={0}
          label="Meals"
          value={String(kpis.mealsToday)}
          sub={servicesCount > 0 ? `of ${servicesCount} services` : "None"}
          icon={<Utensils />}
          glow="success"
          onClick={() => navigateTo("#/app/meals")}
          navLabel="Meals"
        />
        <KpiCard
          index={1}
          label="Balance"
          value={isMoneyUsable(kpis.availableBalanceFormatted) ? kpis.availableBalanceFormatted : "₹0.00"}
          sub="Available"
          icon={<Wallet />}
          glow="primary"
          onClick={() => navigateTo("#/app/payments")}
          navLabel="Payments"
        />
        <KpiCard
          index={2}
          label="Due"
          value={isMoneyUsable(kpis.currentAmountToPayFormatted) ? kpis.currentAmountToPayFormatted : "₹0.00"}
          sub="Unsettled"
          icon={<FileText />}
          glow="warning"
          onClick={() => navigateTo("#/app/billing")}
          navLabel="Billing"
        />
        <KpiCard
          index={3}
          label="Status"
          value={kpis.paymentStatus}
          sub="Payment"
          icon={kpis.paymentStatus === "Settled" ? <BadgeCheck /> : <CalendarClock />}
          glow={
            kpis.paymentStatus === "Overdue" ? "danger" : kpis.paymentStatus === "Due" ? "warning" : "success"
          }
          onClick={() => navigateTo("#/app/billing")}
          navLabel="Billing"
        />
      </div>
      </StaggerItem>

      {/* Today's meals — the agenda's current-day view, live on the dashboard */}
      <StaggerItem>
      <section aria-label="Today's meals" className="space-y-3">

        {todayMeals.length === 0 ? (
          <EmptyState
            icon={Utensils}
            title="No meals today"
            description="Nothing is scheduled for today. Enjoy your day!"
          />
        ) : (
          <div>
            <AgendaDaySection
              dateKey={todayKeyInTz(tz)}
              isToday
              rows={todayMeals.map((m) =>
                agendaRowFromDashboard(
                  m,
                  tz,
                  now,
                  guestsByInstance.get(m.id) ?? 0,
                  guestOverrideByInstance.get(m.id)?.overridden ?? false,
                  guestOverrideByInstance.get(m.id)?.count ?? 0
                )
              )}
              guests={agendaGuestRows(todayGuests, now)}
              expanded={todayExpanded}
              onToggleExpand={() => setTodayExpanded((e) => !e)}
              flash={flash}
              onToggleMeal={(row, next) => {
                const m = todayMeals.find((x) => x.id === row.id);
                if (m) void handleToggle(m, next);
              }}
              onGuestStep={(row, delta) => void handleGuestStep(row.id, todayGuests, delta)}
              onAddGuest={(row) => {
                setGuestDialogDate(todayKeyInTz(tz));
                setGuestDialogInstance(row?.id);
                setGuestOpen(true);
              }}
            />
          </div>
        )}
      </section>
      </StaggerItem>



      {/* Recent activity */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Megaphone className="size-5" aria-hidden />
            </span>
            <h3 className="font-semibold text-base">Recent activity</h3>
          </div>
          <button
            type="button"
            onClick={() => navigateTo("#/app/notifications")}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            View all
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
        </div>

        {recentActivity.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="Nothing yet"
            description="Activity about your meals, bills and tasks will show up here."
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-0.5">
            {recentActivity.map((notif) => {
              const Icon = notificationIcon(notif.type);
              const tone = activityTone(notif.type);
              return (
                <div
                  key={notif.id}
                  onClick={() => {
                    const target = getNotificationTargetRoute(
                      notif.type,
                      "RESIDENT",
                      notif.entityRef
                    );
                    if (target) {
                      navigateTo(target);
                    }
                  }}
                  className="glass-inset hover:glass border border-border/40 group flex items-center gap-3 rounded-full p-2.5 px-3.5 sm:px-4 transition-all hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04] cursor-pointer"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "glass-inset flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      tone
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {notif.title}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {notif.message}
                    </p>
                  </div>
                  <span className="kpi-num shrink-0 text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                    {formatTimeInTz(notif.createdAt, tz)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      {/* Add-guests dialog (opened by the today guest row's Add / +1). */}
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
        todayKey={todayKeyInTz(tz)}
        guestPriceMinor={guestPriceMinor}
        initialDate={guestDialogDate}
        initialInstanceId={guestDialogInstance}
      />
    </StaggerGroup>
  );
}
