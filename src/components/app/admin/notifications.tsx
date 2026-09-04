"use client";

/**
 * Admin Notifications — grouped feed (Today / Yesterday / Earlier) with an
 * All / Unread filter and "mark all read".
 * BoardOps composition, meals-page anatomy: action bar → ONE Notifications
 * section card (Bell icon header, filter pills INSIDE) holding the
 * day-grouped feed.
 * GET /api/v1/notifications?unread=&cursor=
 */

import { Bell, BellOff, Calendar as CalendarIcon, CheckCheck, ClipboardList, ReceiptText, TriangleAlert, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import { GlassButton } from "@/components/glass/GlassButton";
import NotifStack, { type NotifStackItem } from "@/components/glass/NotifStack";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { api, ApiClientError } from "@/lib/api";
import { navigateTo } from "@/hooks/use-hash-route";
import { getNotificationTargetRoute } from "@/lib/notification-routes";
import type { NotificationRow } from "./_shared/types";
import { dayBucket, timeAgo } from "./_shared/format";
import { errMessage, useApiMetaQuery, useInvalidate } from "./_shared/api";
import { FilterChips } from "./_shared/chrome";

const NOTIF_PATH = "/api/v1/notifications";

/* ---- icon per notification type ---- */
function notifIcon(type: string) {
  if (type.includes("PAYMENT")) return Wallet;
  if (type.includes("EXPENSE")) return ReceiptText;
  if (type.includes("BILL")) return ClipboardList;
  if (type.includes("TASK")) return ClipboardList;
  if (type.includes("LEAVE")) return CalendarIcon;
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

type Bucket = "Today" | "Yesterday" | "Earlier";
const BUCKET_ORDER: Bucket[] = ["Today", "Yesterday", "Earlier"];

export default function AdminNotifications() {
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const [markingAll, setMarkingAll] = useState(false);
  const invalidate = useInvalidate();

  const { data: envelope, isLoading, error, refetch } = useApiMetaQuery<NotificationRow[]>(
    NOTIF_PATH,
    { limit: 100 },
    { refetchInterval: 4_000, staleTime: 2_000, refetchOnWindowFocus: true }
  );
  const allNotifications = envelope?.data ?? [];
  const meta = envelope?.meta ?? {};
  const unreadCount = (meta.unreadCount as number | undefined) ?? allNotifications.filter((n) => n.readAt == null).length;

  const items = filter === "unread" ? allNotifications.filter((n) => n.readAt == null) : allNotifications;

  async function markAllRead() {
    setMarkingAll(true);
    try {
      await api(`${NOTIF_PATH}/read-all`, { method: "POST" });
      invalidate([NOTIF_PATH]);
      toast.success("All notifications marked as read");
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setMarkingAll(false);
    }
  }

  async function markRead(id: string) {
    try {
      await api(`${NOTIF_PATH}/${id}/read`, { method: "POST" });
      invalidate([NOTIF_PATH]);
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  function handleRowTap(item: NotifStackItem) {
    void markRead(item.id);
    const target = getNotificationTargetRoute(item.type, "ADMIN", (item as NotificationRow).entityRef);
    if (target) {
      navigateTo(target);
    }
  }

  if (isLoading && !envelope) {
    return (
      <div className="space-y-4">
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (error) {
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

  const grouped: Record<Bucket, NotificationRow[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const n of items) {
    grouped[dayBucket(n.createdAt)].push(n);
  }

  return (
    <StaggerGroup className="space-y-4">
      {/* ONE section card — meals-page anatomy: icon + title + actions header,
          filter pills INSIDE, day-grouped feed below. */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Bell className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold">Notifications</h3>

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

        <div className="mb-3">
          <FilterChips
            chips={[
              { value: "unread", label: "Unread", count: unreadCount },
              { value: "all", label: "All", count: allNotifications.length },
            ]}
            value={filter}
            onChange={(v) => setFilter(v as "unread" | "all")}
          />
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon={filter === "unread" ? BellOff : Bell}
            title={filter === "unread" ? "You're all caught up" : "No notifications yet"}
            description={
              filter === "unread"
                ? "Unread messages will appear here as things happen."
                : "Approvals, bills and policy events will land here."
            }
          />
        ) : (
          <div className="space-y-4">
            {BUCKET_ORDER.filter((b) => grouped[b].length > 0).map((bucket) => (
              <section key={`${bucket}-${filter}`} aria-labelledby={`notif-${bucket}`}>
                <div className="mb-2 flex items-center justify-between gap-3 px-1">
                  <h2 id={`notif-${bucket}`} className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {bucket}
                  </h2>
                  <span className="kpi-num text-[11px] text-muted-foreground">{grouped[bucket].length}</span>
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
