"use client";

/**
 * Admin Announcements — publish (with a mandatory preview step for
 * critical/urgent) and the published board.
 * BoardOps composition, meals-page anatomy: action bar (Publish) → board
 * KPIs → ONE Announcements section card (Megaphone icon header) holding
 * compact type-orb rows (pinned ring + urgent glow accents).
 * GET /api/v1/admin/announcements · POST (previewOnly for the preview step)
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Archive, Calendar, CalendarDays, ChevronRight, Clock, Eye, Info, Megaphone, PartyPopper, Pencil, Pin, Plus, RotateCcw, Trash2, TriangleAlert, Wrench, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { KpiGridSkeleton, ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import GlassToggle from "@/components/glass/GlassToggle";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson, patchJson, deleteJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { ApiClientError } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { errMessage, useInvalidate } from "./_shared/api";
import { currentMonthKeyInTz } from "./_shared/business-date";
import { SelectField, TextAreaField, TextField } from "./_shared/fields";
import { Chip, DetailDialog, KeyValue, KpiGrid, type KpiSpec } from "./_shared/chrome";
import { fmtDateTime } from "./_shared/format";
import type { AnnouncementRow } from "./_shared/types";

const ANNOUNCEMENTS_PATH = "/api/v1/admin/announcements";

function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2026, (m ?? 1) - 1, 1));
}

const TYPE_OPTIONS = [
  { value: "INFO", label: "Info" },
  { value: "ALERT", label: "Alert" },
  { value: "WARNING", label: "Warning" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "EVENT", label: "Event" },
];

const PRIORITY_OPTIONS = [
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
  { value: "CRITICAL", label: "Critical" },
];

const TARGET_OPTIONS = [
  { value: "EVERYONE", label: "Everyone" },
  { value: "RESIDENTS", label: "Residents" },
  { value: "ADMINS", label: "Admins" },
];

const PRIORITY_TONES: Record<string, "neutral" | "warning" | "danger" | "frost"> = {
  NORMAL: "neutral",
  HIGH: "warning",
  URGENT: "warning",
  CRITICAL: "danger",
};

/** Type-tinted gradient orb for announcement rows (BoardOps row anatomy). */
const TYPE_META: Record<string, { icon: LucideIcon; orb: string }> = {
  INFO: { icon: Info, orb: "frost" },
  ALERT: { icon: TriangleAlert, orb: "rose" },
  WARNING: { icon: TriangleAlert, orb: "amber" },
  MAINTENANCE: { icon: Wrench, orb: "sky" },
  EVENT: { icon: PartyPopper, orb: "emerald" },
};

function typeMeta(type: string): { icon: LucideIcon; orb: string } {
  return TYPE_META[type] ?? TYPE_META.INFO;
}

export default function AdminAnnouncements() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const currentMonthKey = currentMonthKeyInTz(tz);
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const monthKey = monthParam ?? currentMonthKey;
  const { data, isLoading, error, refetch } = useApiQuery<AnnouncementRow[]>(`${ANNOUNCEMENTS_PATH}?month=${monthKey}`);
  const [formOpen, setFormOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<AnnouncementRow | null>(null);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementRow | null>(null);
  const invalidate = useInvalidate();

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <KpiGridSkeleton count={3} />
        <ListSkeleton rows={4} />
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

  const announcements = data ?? [];
  const nowMs = Date.now();
  const pinnedCount = announcements.filter((a) => a.pinned).length;
  const expiringCount = announcements.filter((a) => {
    if (!a.expiresAt) return false;
    const exp = new Date(a.expiresAt).getTime();
    return exp > nowMs && exp < nowMs + 7 * 86_400_000;
  }).length;

  const kpis: KpiSpec[] = [
    { label: "Total", value: String(announcements.length), sub: "Published", icon: <Megaphone />, tone: "primary", glow: "primary" },
    { label: "Pinned", value: String(pinnedCount), sub: "Board", icon: <Pin />, tone: "primary", glow: "primary" },
    { label: "Expiring", value: String(expiringCount), sub: "Within 7d", icon: <Clock />, tone: "danger", glow: "danger" },
  ];

  return (
    <StaggerGroup className="space-y-4">
      {/* Month navigation — centered picker capsule */}
      <StaggerItem>
      <PickerCapsule
        onPrev={() => setMonthParam(shiftMonthKey(monthKey, -1))}
        onNext={() => setMonthParam(shiftMonthKey(monthKey, 1))}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPillClick={() => setMonthParam(undefined)}
        pillAriaLabel="Reset to the current month"
        resettable={monthKey !== currentMonthKey}
      >
        <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 text-center leading-tight">
          <span className="block truncate text-sm font-bold text-primary">{monthLongName(monthKey)}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{monthKey.slice(0, 4)}</span>
        </span>
      </PickerCapsule>
      </StaggerItem>

      {/* KPIs — board overview (3-column layout like meals) */}
      <StaggerItem>
      <KpiGrid kpis={kpis} className="grid grid-cols-3 gap-2 sm:gap-3" />
      </StaggerItem>

      {/* Primary action — Publish centered below KPIs */}
      <StaggerItem>
      <div className="flex items-center justify-center">
        <GlassButton
          variant="primary"
          icon={<Plus />}
          onClick={() => {
            setEditingAnnouncement(null);
            setFormOpen(true);
          }}
        >
          Publish
        </GlassButton>
      </div>
      </StaggerItem>

      {/* ONE section card — meals-page anatomy: icon + title + count header,
          symmetrical type-orb rows below matching payments. */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Megaphone className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold">Announcements</h3>
        </div>

        {announcements.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No announcements yet"
            description="Welcome notes, maintenance windows and billing reminders live here."
            action={
              <GlassButton variant="secondary" icon={<Plus />} onClick={() => setFormOpen(true)}>
                Publish
              </GlassButton>
            }
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {announcements.map((a, i) => {
                const expired = a.expiresAt && new Date(a.expiresAt).getTime() < Date.now();
                const scheduled = new Date(a.publishAt).getTime() > Date.now();
                const meta = typeMeta(a.type);
                const OrbIcon = a.pinned ? Pin : meta.icon;
                const orbToken = a.pinned ? "frost" : meta.orb;
                return (
                  <motion.div
                    key={a.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2, ease: "easeOut", delay: Math.min(i * 0.04, 0.2) }}
                  >
                    <GlassCard className={cn("overflow-hidden rounded-2xl", a.pinned && "ring-1 ring-primary/30")}>
                      <div
                        className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                        onClick={() => setSelectedAnnouncement(a)}
                      >
                      {/* Top row: Identity & Time (Left), Status & Priority (Right) — fixed h-10 */}
                      <div className="flex h-10 items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <MealOrb icon={<OrbIcon />} colorToken={orbToken} size="sm" />
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-foreground tracking-tight" title={a.title}>
                              {a.title}
                            </h4>
                            <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <Clock className="size-3 shrink-0" aria-hidden />
                              {fmtDateTime(a.publishAt, tz)}
                            </p>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          {expired ? (
                            <Chip tone="danger" className="text-[10px] px-2 py-0.5 shrink-0">
                              expired
                            </Chip>
                          ) : scheduled ? (
                            <Chip tone="warning" className="text-[10px] px-2 py-0.5 shrink-0">
                              scheduled
                            </Chip>
                          ) : (
                            <Chip tone={PRIORITY_TONES[a.priority] ?? "neutral"} className="text-[10px] px-2 py-0.5 shrink-0">
                              {a.priority.toLowerCase()}
                            </Chip>
                          )}
                        </div>
                      </div>

                      {/* Bottom row: Badges on left, Details in a pill on right — strictly 1 row fixed h-7 */}
                      <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <Chip tone="neutral" className="text-[10px] px-2 py-0.5 shrink-0">
                            {a.type.toLowerCase()}
                          </Chip>
                          {a.pinned && (
                            <Chip tone="frost" className="text-[10px] px-2 py-0.5 shrink-0">
                              pinned
                            </Chip>
                          )}
                          <Chip tone="frost" className="text-[10px] px-2 py-0.5 shrink-0">
                            {a.target === "EVERYONE" ? "everyone" : a.target === "RESIDENTS" ? "residents" : "admins"}
                          </Chip>
                          {a.expiresAt && (
                            <span className="kpi-num text-[11px] text-muted-foreground truncate shrink-0">
                              until {fmtDateTime(a.expiresAt, tz)}
                            </span>
                          )}
                        </div>

                        {/* Actions in tactile glass pills */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingAnnouncement(a);
                              setFormOpen(true);
                            }}
                            aria-label={`Edit ${a.title}`}
                            className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            <Pencil className="size-3" aria-hidden />
                            <span>Edit</span>
                          </motion.button>
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedAnnouncement(a);
                            }}
                            aria-label={`Open details for ${a.title}`}
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
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      {selectedAnnouncement && (
        <AnnouncementDetailDialog
          announcement={selectedAnnouncement}
          tz={tz}
          onClose={() => setSelectedAnnouncement(null)}
          onActionDone={() => {
            invalidate([ANNOUNCEMENTS_PATH, "/api/v1/notifications"]);
            void refetch();
          }}
        />
      )}

      {formOpen && (
        <AnnouncementFormDialog
          open
          editing={editingAnnouncement}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) setEditingAnnouncement(null);
          }}
          onSaved={() => {
            invalidate([ANNOUNCEMENTS_PATH, "/api/v1/notifications"]);
            void refetch();
          }}
        />
      )}
    </StaggerGroup>
  );
}

/* ---------------------------------------------------- detail dialog */

function AnnouncementDetailDialog({
  announcement,
  tz,
  onClose,
  onActionDone,
}: {
  announcement: AnnouncementRow | null;
  tz: string;
  onClose: () => void;
  onActionDone: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [acting, setActing] = useState(false);

  if (!announcement) return null;
  const expired = announcement.expiresAt && new Date(announcement.expiresAt).getTime() < Date.now();
  const scheduled = new Date(announcement.publishAt).getTime() > Date.now();

  async function handleDelete() {
    if (!announcement) return;
    setActing(true);
    try {
      await deleteJson(`${ANNOUNCEMENTS_PATH}/${announcement.id}`);
      toast.success("Announcement deleted");
      onActionDone();
      onClose();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
      setConfirmDelete(false);
    }
  }

  async function handleArchive() {
    if (!announcement) return;
    setActing(true);
    try {
      await patchJson(`${ANNOUNCEMENTS_PATH}/${announcement.id}`, { action: "ARCHIVE" });
      toast.success("Announcement archived");
      onActionDone();
      onClose();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  return (
    <>
      <DetailDialog
        open={announcement != null}
        onOpenChange={(open) => !open && onClose()}
        title={announcement.title}
        description={`Published on ${fmtDateTime(announcement.publishAt, tz)}`}
        wide
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <GlassButton
                variant="destructive"
                size="sm"
                icon={<Trash2 className="size-4" />}
                loading={acting}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </GlassButton>
              {!expired && (
                <GlassButton
                  variant="secondary"
                  size="sm"
                  icon={<Archive className="size-4" />}
                  loading={acting}
                  onClick={() => void handleArchive()}
                >
                  Archive
                </GlassButton>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <GlassButton variant="ghost" size="sm" onClick={onClose}>
                Close
              </GlassButton>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Details</p>
            <div className="space-y-0.5">
              <KeyValue
                label="Priority"
                value={<Chip tone={PRIORITY_TONES[announcement.priority] ?? "neutral"}>{announcement.priority.toLowerCase()}</Chip>}
              />
              <KeyValue label="Type" value={<Chip tone="neutral">{announcement.type.toLowerCase()}</Chip>} />
              <KeyValue
                label="Target audience"
                value={announcement.target === "EVERYONE" ? "Everyone" : announcement.target === "RESIDENTS" ? "Residents" : "Admins"}
              />
              <KeyValue label="Pinned to board" value={announcement.pinned ? "Yes" : "No"} />
              <KeyValue label="Publish date" value={fmtDateTime(announcement.publishAt, tz)} />
              <KeyValue
                label="Expires at"
                value={announcement.expiresAt ? fmtDateTime(announcement.expiresAt, tz) : "No expiry"}
              />
              {scheduled && <KeyValue label="Status" value={<Chip tone="warning">Scheduled</Chip>} />}
              {expired && <KeyValue label="Status" value={<Chip tone="danger">Expired</Chip>} />}
            </div>
          </div>

          <div className="border-t border-border/20 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Message</p>
            <div className="glass-inset rounded-xl p-3.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {announcement.message}
            </div>
          </div>
        </div>
      </DetailDialog>

      {confirmDelete && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmDelete(false)}
          title="Delete announcement"
          description="Are you sure you want to delete this announcement? It will be permanently removed from all resident boards."
          confirmLabel="Delete announcement"
          tone="destructive"
          loading={acting}
          onConfirm={() => void handleDelete()}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ publish form */

function toIsoOrNull(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function AnnouncementFormDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: AnnouncementRow | null;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(editing?.title ?? "");
  const [message, setMessage] = useState(editing?.message ?? "");
  const [type, setType] = useState(editing?.type ?? "INFO");
  const [priority, setPriority] = useState(editing?.priority ?? "NORMAL");
  const [target, setTarget] = useState(editing?.target ?? "EVERYONE");
  const [publishAt, setPublishAt] = useState(editing?.publishAt ? editing.publishAt.slice(0, 10) : "");
  const [expiresAt, setExpiresAt] = useState(editing?.expiresAt ? editing.expiresAt.slice(0, 10) : "");
  const [pinned, setPinned] = useState(editing?.pinned ?? false);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  useEffect(() => {
    if (editing) {
      setTitle(editing.title);
      setMessage(editing.message);
      setType(editing.type);
      setPriority(editing.priority);
      setTarget(editing.target);
      setPublishAt(editing.publishAt ? editing.publishAt.slice(0, 10) : "");
      setExpiresAt(editing.expiresAt ? editing.expiresAt.slice(0, 10) : "");
      setPinned(editing.pinned);
    } else {
      setTitle("");
      setMessage("");
      setType("INFO");
      setPriority("NORMAL");
      setTarget("EVERYONE");
      setPublishAt("");
      setExpiresAt("");
      setPinned(false);
    }
    setFields({});
    setAwaitingConfirm(false);
  }, [editing, open]);

  const isHighStakes = priority === "URGENT" || priority === "CRITICAL";
  const valid = title.trim().length >= 3 && message.trim().length >= 3;

  function reset() {
    setTitle("");
    setMessage("");
    setType("INFO");
    setPriority("NORMAL");
    setTarget("EVERYONE");
    setPublishAt("");
    setExpiresAt("");
    setPinned(false);
    setFields({});
    setAwaitingConfirm(false);
  }

  function body(previewOnly: boolean) {
    return {
      title: title.trim(),
      message: message.trim(),
      type,
      priority,
      target,
      publishAt: toIsoOrNull(publishAt),
      expiresAt: toIsoOrNull(expiresAt),
      pinned,
      previewOnly,
    };
  }

  async function submit() {
    setSaving(true);
    setFields({});
    try {
      if (isHighStakes && !awaitingConfirm && !editing) {
        // Preview first — nothing is written until the explicit confirmation.
        await postJson(ANNOUNCEMENTS_PATH, body(true));
        setAwaitingConfirm(true);
        setSaving(false);
        return;
      }
      if (editing) {
        await patchJson(`${ANNOUNCEMENTS_PATH}/${editing.id}`, {
          ...body(false),
          action: "REPUBLISH",
        });
        toast.success("Announcement saved & republished", {
          description: `${title.trim()} · published`,
        });
      } else {
        await postJson(ANNOUNCEMENTS_PATH, body(false));
        toast.success("Announcement published", {
          description: `${title.trim()} · ${priority.toLowerCase()} priority`,
        });
      }
      onSaved();
      onOpenChange(false);
      reset();
    } catch (err) {
      if (err instanceof ApiClientError && err.fields) setFields(err.fields);
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="glass-strong rounded-2xl border-0 p-0 sm:max-w-lg">
        <div className="flex max-h-[85vh] flex-col">
          <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">
              {awaitingConfirm ? "Review before publishing" : editing ? "Edit announcement" : "Publish announcement"}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">
              {awaitingConfirm
                ? "You're publishing at a high priority. Read it once more — this is exactly what residents will see."
                : editing
                ? "Update details, priority or schedule. Changes will be saved and republished."
                : "Notices render as plain text and are delivered to the notification feed."}
            </DialogDescription>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
            {awaitingConfirm ? (
              <div className="space-y-4">
                <div className="glass-inset rounded-md p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone={PRIORITY_TONES[priority] ?? "neutral"}>{priority.toLowerCase()}</Chip>
                    <Chip tone="neutral">{type.toLowerCase()}</Chip>
                    {pinned && <Chip tone="frost">pinned</Chip>}
                  </div>
                  <p className="mt-2.5 text-sm font-semibold">{title.trim()}</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/85">{message.trim()}</p>
                </div>
                <div className="flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning/8 p-3.5">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    Urgent and critical notices interrupt — make sure the wording and timing are right before sending.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <TextField label="Title" value={title} onChange={setTitle} placeholder="e.g. Kitchen maintenance next week" maxLength={140} error={fields.title} />
                <TextAreaField label="Message" value={message} onChange={setMessage} rows={4} maxLength={2000} placeholder="What residents need to know…" error={fields.message} />
                <div className="grid grid-cols-2 gap-2.5">
                  <SelectField label="Type" value={type} onChange={setType} options={TYPE_OPTIONS} />
                  <SelectField label="Priority" value={priority} onChange={setPriority} options={PRIORITY_OPTIONS} />
                </div>
                <SelectField label="Audience" value={target} onChange={setTarget} options={TARGET_OPTIONS} />
                <div className="grid grid-cols-2 gap-2.5">
                  <TextField label="Publish at (optional)" type="date" value={publishAt.slice(0, 10)} onChange={(v) => setPublishAt(v ? `${v}T09:00` : "")} hint="Empty = immediately. Time defaults to 9:00 AM." />
                  <TextField label="Expires on (optional)" type="date" value={expiresAt.slice(0, 10)} onChange={(v) => setExpiresAt(v ? `${v}T23:59` : "")} hint="Hidden after this date." />
                </div>
                <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Pin to top</p>
                    <p className="text-[11px] text-muted-foreground">Pinned notices stay first on the board.</p>
                  </div>
                  <GlassToggle checked={pinned} onChange={(next) => setPinned(next)} label="Pin to top" />
                </div>
              </div>
            )}
          </div>

          <div className="safe-b flex flex-wrap items-center justify-end gap-2 border-t border-border/50 px-5 py-4 sm:px-6">
            {awaitingConfirm ? (
              <>
                <GlassButton variant="ghost" onClick={() => setAwaitingConfirm(false)} disabled={saving}>
                  Keep editing
                </GlassButton>
                <GlassButton variant="destructive" icon={<Eye />} loading={saving} onClick={() => void submit()}>
                  Publish now
                </GlassButton>
              </>
            ) : (
              <>
                <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
                  Cancel
                </GlassButton>
                <GlassButton
                  variant={isHighStakes && !editing ? "secondary" : "primary"}
                  icon={isHighStakes && !editing ? <Eye /> : editing ? <RotateCcw /> : <Megaphone />}
                  loading={saving}
                  disabled={!valid}
                  onClick={() => void submit()}
                >
                  {isHighStakes && !editing ? "Preview first" : editing ? "Save & republish" : "Publish"}
                </GlassButton>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
