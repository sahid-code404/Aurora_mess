"use client";

/**
 * Resident Notifications (#/app/notifications) — matching Admin Notifications design:
 * ONE Notifications section card (Bell icon header, inline right-aligned "Mark all read",
 * filter chips INSIDE) holding the day-grouped feed (Today / Yesterday / Earlier)
 * with tone-tinted orbs, unread ring + dot, and genuine notifications only.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bell,
  BellOff,
  Calendar as CalendarIcon,
  CheckCheck,
  CheckCircle2,
  ClipboardList,
  FileText,
  Landmark,
  ReceiptText,
  TriangleAlert,
  Utensils,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";

import { useSession } from "@/hooks/use-session";
import GlassCard from "@/components/glass/GlassCard";
import GlassButton from "@/components/glass/GlassButton";
import NotifStack, { type NotifStackItem } from "@/components/glass/NotifStack";
import { EmptyState } from "@/components/glass/EmptyState";
import { ErrorState } from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { DropletFilterChips } from "@/components/glass/DropletFilterChips";
import { navigateTo } from "@/hooks/use-hash-route";
import { getNotificationTargetRoute } from "@/lib/notification-routes";

import { apiJson, useEnvelopeQuery } from "./_shared/api";
import { addDaysToKey, dateKeyInTz, todayKeyInTz, friendlyError } from "./_shared/format";
import type { ActivityNotification, NotificationsMeta } from "./_shared/types";
import { cn } from "@/lib/utils";

/* ---- Exclude personal self-action activity logs ---- */
const ACTIVITY_TYPES = new Set([
  "GUEST_MEAL_ADDED",
  "GUEST_MEAL_ADJUSTED",
  "GUEST_MEAL_CANCELLED",
  "MEAL_TOGGLED",
]);

/* ---- icon per notification type (matching admin) ---- */
function notifIcon(type: string): LucideIcon {
  if (type.includes("PAYMENT")) return Wallet;
  if (type.includes("EXPENSE")) return ReceiptText;
  if (type.includes("BILL")) return FileText;
  if (type.includes("TASK")) return ClipboardList;
  if (type.includes("LEAVE")) return CalendarIcon;
  if (type.includes("MEAL")) return Utensils;
  if (type.includes("ALERT") || type.includes("DEFICIT")) return TriangleAlert;
  return Bell;
}

/** Tone-tinted icon orb (BoardOps notifications-row pattern). */
function notifTone(type: string): string {
  if (
    type.includes("REJECTED") ||
    type.includes("ALERT") ||
    type.includes("DEFICIT") ||
    type.includes("RESTRICT") ||
    type.includes("OVERDUE")
  ) {
    return "border-danger/30 bg-danger/12 text-danger";
  }
  if (type.includes("APPROVED") || type.includes("ACCEPTED") || type.includes("SETTLED")) {
    return "border-success/30 bg-success/12 text-success";
  }
  if (type.includes("PENDING") || type.includes("SUBMITTED") || type.includes("DUE") || type.includes("GRACE")) {
    return "border-warning/30 bg-warning/14 text-warning";
  }
  return "border-primary/28 bg-primary/12 text-primary";
}

/** Friendly relative time: "just now", "12m ago", "3h ago", "2d ago", else date. */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type Bucket = "Today" | "Yesterday" | "Earlier";
const BUCKET_ORDER: Bucket[] = ["Today", "Yesterday", "Earlier"];

function dayBucket(iso: string, tz: string, todayKey: string, yesterdayKey: string): Bucket {
  const key = dateKeyInTz(new Date(iso), tz);
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return "Earlier";
}

export default function ResidentNotifications() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const [markingAll, setMarkingAll] = useState(false);

  const query = useEnvelopeQuery<ActivityNotification[], NotificationsMeta>(
    "/api/v1/notifications",
    { limit: 100 },
    { refetchInterval: 4_000, staleTime: 2_000 }
  );

  const rawNotifications = query.data?.data ?? [];

  // Filter out any self-action activity logs — only show genuine notifications
  const allNotifications = useMemo(() => {
    return rawNotifications.filter((n) => !ACTIVITY_TYPES.has(n.type));
  }, [rawNotifications]);

  const unreadCount = useMemo(() => {
    return allNotifications.filter((n) => n.readAt == null).length;
  }, [allNotifications]);

  const items = useMemo(() => {
    if (filter === "unread") {
      return allNotifications.filter((n) => n.readAt == null);
    }
    return allNotifications;
  }, [allNotifications, filter]);

  const todayKey = todayKeyInTz(tz);
  const yesterdayKey = addDaysToKey(todayKey, -1);

  const grouped = useMemo(() => {
    const buckets: Record<Bucket, ActivityNotification[]> = { Today: [], Yesterday: [], Earlier: [] };
    for (const n of items) {
      const b = dayBucket(n.createdAt, tz, todayKey, yesterdayKey);
      buckets[b].push(n);
    }
    return buckets;
  }, [items, tz, todayKey, yesterdayKey]);

  async function markRead(id: string) {
    // Optimistically vanish from queries
    queryClient.setQueriesData<unknown>(
      { queryKey: ["api", "/api/v1/notifications"] },
      (old) => {
        const env = old as { data?: ActivityNotification[]; meta?: NotificationsMeta } | null | undefined;
        if (!env || !Array.isArray(env.data)) return old;
        return {
          ...env,
          data: env.data.filter((n) => n.id !== id),
          meta: { ...env.meta, unreadCount: Math.max(0, (env.meta?.unreadCount ?? 0) - 1) },
        };
      }
    );
    try {
      await apiJson(`/api/v1/notifications/${id}/read`, "POST", {});
      void queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/notifications"] });
    } catch (err) {
      toast.error(friendlyError(err, "We couldn't resolve this notification. Please try again."));
      void query.refetch();
    }
  }

  async function markAllRead() {
    setMarkingAll(true);
    try {
      await apiJson("/api/v1/notifications/read-all", "POST", {});
      void queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/notifications"] });
      toast.success("All notifications completed and cleared");
    } catch (err) {
      toast.error(friendlyError(err, "We couldn't clear notifications. Please try again."));
    } finally {
      setMarkingAll(false);
    }
  }

  function handleRowTap(item: NotifStackItem) {
    void markRead(item.id);
    const target = getNotificationTargetRoute(
      item.type,
      "RESIDENT",
      (item as ActivityNotification).entityRef
    );
    if (target) {
      navigateTo(target);
    }
  }

  if (query.isPending) {
    return (
      <div className="space-y-4">
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (query.isError) {
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

  return (
    <StaggerGroup className="space-y-4">
      {/* ONE section card matching Admin Notifications:
          Bell icon header + inline "Mark all read" action,
          Filter chips INSIDE, day-grouped feed (Today / Yesterday / Earlier) below. */}
      <StaggerItem>
        <GlassCard className="p-4 border border-border/40">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Bell className="size-5" aria-hidden />
            </span>
            <h3 className="font-semibold text-base">Notifications</h3>

            <div className="ml-auto">
              <GlassButton
                variant="secondary"
                size="sm"
                icon={<CheckCheck className="size-4" />}
                loading={markingAll}
                disabled={unreadCount === 0}
                onClick={() => void markAllRead()}
              >
                Mark all read
              </GlassButton>
            </div>
          </div>

          {/* Filter Chips inside the card (Unread first with count, then All) */}
          <div className="mb-3">
            <DropletFilterChips
              chips={[
                { value: "unread", label: "Unread", count: unreadCount },
                { value: "all", label: "All", count: allNotifications.length },
              ]}
              value={filter}
              onChange={(v) => setFilter(v as "unread" | "all")}
              layoutId="resident-notifications-chips"
              aria-label="Filter notifications"
            />
          </div>

          {items.length === 0 ? (
            <EmptyState
              icon={filter === "unread" ? BellOff : Bell}
              title={filter === "unread" ? "You're all caught up" : "No notifications yet"}
              description={
                filter === "unread"
                  ? "Unread messages will appear here as things happen."
                  : "Approvals, bills, tasks, and meal events will land here."
              }
            />
          ) : (
            <div className="space-y-4">
              {BUCKET_ORDER.filter((b) => grouped[b].length > 0).map((bucket) => (
                <section key={`${bucket}-${filter}`} aria-labelledby={`notif-${bucket}`}>
                  <div className="mb-2 flex items-center justify-between gap-3 px-1">
                    <h2
                      id={`notif-${bucket}`}
                      className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                    >
                      {bucket}
                    </h2>
                    <span className="kpi-num text-[11px] text-muted-foreground">
                      {grouped[bucket].length}
                    </span>
                  </div>
                  <NotifStack
                    label={bucket}
                    items={grouped[bucket]}
                    iconFor={notifIcon}
                    toneFor={notifTone}
                    timeFor={timeAgo}
                    onMarkRead={(id) => void markRead(id)}
                    onRowTap={handleRowTap}
                  />
                </section>
              ))}
            </div>
          )}
        </GlassCard>
      </StaggerItem>
    </StaggerGroup>
  );
}
