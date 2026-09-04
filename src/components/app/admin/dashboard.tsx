"use client";

/**
 * Admin Dashboard — greeting (institution-local time), 4 KPIs, Needs
 * Attention shortcuts and the recent activity feed rendered as an
 * Apple-style notification STACK (first 5 rows show; the rest fold behind
 * with peek cards that physically slide while scrolling).
 * GET /api/v1/admin/dashboard
 * Liquid Glass II: BoardOps composition — hero greeting card with
 * gradient name, auto-fit KPI grid (every card navigates), stacked
 * activity rows with icon orbs.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import {
  Banknote,
  CalendarClock,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  ReceiptText,
  TriangleAlert,
  Users,
  Utensils,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import GlassCard from "@/components/glass/GlassCard";
import { KpiCard, type KpiGlow } from "@/components/glass/KpiCard";
import StatusBadge from "@/components/glass/StatusBadge";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { KpiGridSkeleton, Skeleton } from "@/components/glass/LoadingSkeleton";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { useApiQuery } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { navigateTo } from "@/hooks/use-hash-route";
import { ApiClientError } from "@/lib/api";
import { getNotificationTargetRoute } from "@/lib/notification-routes";
import { gradientForName, getTimeGreeting } from "@/lib/gradients";
import { cn } from "@/lib/utils";
import { fmtDateTime, timeAgo } from "./_shared/format";

interface DashboardData {
  greeting: { text: string; icon: string; institutionName: string; localTime: string };
  kpis: {
    residents: number;
    mealsToday: number;
    guestsToday: number;
    availableFunds: number;
    availableFundsFormatted: string;
    mealCharge: number | null;
    mealChargeFormatted: string | null;
    period: { year: number; month: number };
  };
  needsAttention: { key: string; label: string; count: number; href: string }[];
  recentActivity: {
    id: string;
    action: string;
    copy: string;
    entityType: string;
    entityId: string;
    actorRole: string;
    occurredAt: string;
  }[];
}

/** KPI metric spec — every card navigates to its destination (BoardOps). */
interface AdminKpiSpec {
  label: string;
  value: string;
  sub: ReactNode;
  icon: ReactNode;
  glow: KpiGlow;
  href: string;
  navLabel: string;
}

/* ---- quiet action icons per attention key ---- */
const ATTENTION_ICONS: Record<string, typeof CircleAlert> = {
  pendingResidentApprovals: Users,
  pendingPayments: Wallet,
  pendingLeaveRequests: CalendarClock,
  submittedTaskSubmissions: ClipboardCheck,
  pendingExpenses: ReceiptText,
  billingBlockers: TriangleAlert,
};

/* ---- activity icons by audit action prefix ---- */
const ACTIVITY_ICONS: Record<string, typeof ReceiptText> = {
  PAYMENT: Wallet,
  EXPENSE: ReceiptText,
  BILLING: Banknote,
  RESIDENT: Users,
  MEAL: Utensils,
  TASK: ClipboardCheck,
  CALENDAR: CalendarClock,
  SETTINGS: TriangleAlert,
};

function activityIcon(action: string): typeof ReceiptText {
  const prefix = action.split("_")[0] ?? "";
  return ACTIVITY_ICONS[prefix] ?? CircleAlert;
}

/** Short human label for audit action codes. */
function actionLabel(action: string): string {
  const words = action.toLowerCase().split("_");
  return words
    .map((w) => (w === "by" ? "by" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Tone for the activity stack orb, keyed off audit action keywords. */
function activityTone(action: string): string {
  if (
    action.includes("REJECTED") ||
    action.includes("ALERT") ||
    action.includes("DEFICIT") ||
    action.includes("RESTRICT") ||
    action.includes("OVERDUE")
  ) {
    return "border-danger/30 bg-danger/12 text-danger";
  }
  if (action.includes("APPROVED") || action.includes("ACCEPTED") || action.includes("SETTLED")) {
    return "border-success/30 bg-success/12 text-success";
  }
  if (action.includes("PENDING") || action.includes("SUBMITTED") || action.includes("DUE")) {
    return "border-warning/30 bg-warning/14 text-warning";
  }
  return "border-primary/28 bg-primary/12 text-primary";
}

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

export default function AdminDashboard() {
  const { data, isLoading, error, refetch } = useApiQuery<DashboardData>("/api/v1/admin/dashboard");
  const reducedMotion = useReducedMotion();
  const { profile, institution } = useSession();

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-44" />
        </div>
        <KpiGridSkeleton count={4} />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
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

  const { greeting, kpis, needsAttention, recentActivity } = data;

  const mealChargeSub = kpis.mealCharge == null ? (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span, not button — this text now renders inside the KpiCard's
            whole-card <button>; a nested interactive would be invalid HTML. */}
        <span className="cursor-help underline decoration-dotted underline-offset-2">
          Month just started
        </span>
      </TooltipTrigger>
      <TooltipContent className="glass-strong border-0 rounded-lg text-[12px] font-normal max-w-56 text-center">
        The per-meal charge appears once there are approved expenses and meals to divide by.
      </TooltipContent>
    </Tooltip>
  ) : (
    `per meal · ${greeting.institutionName}`
  );

  const attentionTotal = needsAttention.reduce((sum, item) => sum + item.count, 0);

  /* BoardOps GreetingCard inputs: client-local time greeting + deterministic
     per-name gradient for the headline words. */
  const adminName = profile?.fullName?.trim() || "";
  const adminFirstName = adminName ? (adminName.split(/\s+/)[0] ?? "") : "";
  const adminGradient = gradientForName(adminName || "Admin");
  const timeGreeting = getTimeGreeting();

  const kpiSpecs: AdminKpiSpec[] = [
    {
      label: "Residents",
      value: String(kpis.residents),
      sub: "Active",
      icon: <Users />,
      glow: "success",
      href: "#/admin/residents",
      navLabel: "Residents",
    },
    {
      label: "Meals",
      value: String(kpis.mealsToday + kpis.guestsToday),
      sub:
        kpis.guestsToday > 0
          ? `${kpis.mealsToday} reg + ${kpis.guestsToday} gst`
          : "Today",
      icon: <Utensils />,
      glow: "success",
      href: "#/admin/meals",
      navLabel: "Meals",
    },
    {
      label: "Funds",
      value: kpis.availableFundsFormatted,
      sub: "Available",
      icon: <Wallet />,
      glow: "primary",
      href: "#/admin/funds",
      navLabel: "Funds",
    },
    {
      label: "Rate",
      value: kpis.mealChargeFormatted ?? "—",
      sub: "Meal charge",
      icon: <Banknote />,
      glow: "warning",
      href: "#/admin/billing",
      navLabel: "Billing",
    },
  ];

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
              <span
                className={cn("bg-gradient-to-br bg-clip-text text-transparent", adminGradient)}
              >
                {adminFirstName ? `Admin ${adminFirstName}` : "Admin"}
              </span>{" "}
              <span aria-hidden className="text-[26px] sm:text-[30px]">
                {timeGreeting.emoji}
              </span>
            </h1>
          </div>
          <div className="shrink-0">
            <DateTimePill timezone={institution?.timezone} />
          </div>
        </div>
      </GlassCard>
      </StaggerItem>

      {/* KPIs — BoardOps auto-fit grid; every card navigates */}
      <StaggerItem>
      <div className="grid-kpi gap-3">
        {kpiSpecs.map((k, i) => (
          <KpiCard
            key={k.label}
            index={i}
            label={k.label}
            value={k.value}
            sub={k.sub}
            icon={k.icon}
            glow={k.glow}
            onClick={() => navigateTo(k.href)}
            navLabel={k.navLabel}
          />
        ))}
      </div>
      </StaggerItem>

      {/* Needs attention — compact when clear, auto-expands with items */}
      <StaggerItem>
      <GlassCard className={cn("p-4", needsAttention.length === 0 && "py-3")}>
        <div className={cn("flex items-center justify-between gap-2", needsAttention.length > 0 && "mb-3")}>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-xl",
                needsAttention.length === 0
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-warning/15 text-warning"
              )}
            >
              {needsAttention.length === 0 ? (
                <CheckCheck className="size-5" aria-hidden />
              ) : (
                <TriangleAlert className="size-5" aria-hidden />
              )}
            </span>
            <div className="min-w-0">
              <h3 className="font-semibold text-base">Needs attention</h3>
              {needsAttention.length === 0 && (
                <p className="text-xs text-muted-foreground">You're all caught up — no pending items.</p>
              )}
            </div>
          </div>
          {needsAttention.length === 0 ? (
            <StatusBadge status="APPROVED" label="All clear" />
          ) : (
            <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-[11px] font-bold text-warning">
              {attentionTotal} pending
            </span>
          )}
        </div>

        {needsAttention.length > 0 && (
          <div className="space-y-2">
            {needsAttention.map((item) => {
              const Icon = ATTENTION_ICONS[item.key] ?? CircleAlert;
              return (
                <div
                  key={item.key}
                  onClick={() => navigateTo(item.href)}
                  className="glass-inset hover:glass border border-border/40 group flex items-center gap-3 rounded-full p-2.5 px-3.5 sm:px-4 transition-all hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04] cursor-pointer"
                >
                  <span
                    aria-hidden
                    className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-full border border-warning/30 bg-warning/14 text-warning text-xs font-semibold"
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.label}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {item.count} open
                    </p>
                  </div>
                  <span className="kpi-num shrink-0 text-[11px] font-semibold text-warning flex items-center gap-1.5 group-hover:text-foreground transition-colors">
                    <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-[11px] font-bold text-warning">
                      {item.count}
                    </span>
                    <ChevronRight className="size-3.5 text-muted-foreground/60 group-hover:text-foreground" />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      {/* Recent activity */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ClipboardCheck className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">Recent activity</h3>
        </div>

        {recentActivity.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No recent activity yet"
            description="Approvals, overrides and billing events will show up here."
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-0.5">
            {recentActivity.map((event) => {
              const Icon = activityIcon(event.action);
              const tone = activityTone(event.action);
              return (
                <div
                  key={event.id}
                  onClick={() => {
                    const target = getNotificationTargetRoute(event.action, "ADMIN", event.entityId);
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
                      {actionLabel(event.action)}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {event.copy}
                    </p>
                  </div>
                  <span className="kpi-num shrink-0 text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                    {timeAgo(event.occurredAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>
      </StaggerItem>
    </StaggerGroup>
  );
}
