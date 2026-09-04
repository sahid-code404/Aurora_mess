"use client";

/**
 * Admin Calendar — BoardOps calendar composition on the Aurora glass theme:
 * action bar → centered PickerCapsule month navigation → GlassCard month
 * grid (Sun-first, aspect-square cells, today ring, past dimmed, event dots
 * per type with token tones) → ONE events section card (CalendarDays icon
 * header) with type-orb rows and the meal-impact create flow.
 * GET /api/v1/calendar?from&to · POST /admin/calendar ·
 * POST /admin/calendar/impact · DELETE /admin/calendar/:id
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  PartyPopper,
  Plus,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import MealOrb from "@/components/glass/MealOrb";
import StatusBadge from "@/components/glass/StatusBadge";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import GlassToggle from "@/components/glass/GlassToggle";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson, deleteJson } from "@/hooks/use-api-query";
import { ApiClientError } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { errMessage, useInvalidate } from "./_shared/api";
import { SelectField, TextAreaField, TextField } from "./_shared/fields";
import { Chip, OverflowMenu } from "./_shared/chrome";
import { fmtDate, todayKey, initialsOf } from "./_shared/format";
import type { CalendarEventRow, MealDefinitionRow } from "./_shared/types";

const CAL_GET_PATH = "/api/v1/calendar";
const CAL_ADMIN_PATH = "/api/v1/admin/calendar";
const LEAVE_PATH = "/api/v1/admin/leave-requests";

interface LeaveRequestRow {
  id: string;
  residentId: string;
  residentName: string;
  roomNumber: string | null;
  startDate: string;
  endDate: string;
  dayCount: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  mealScope: "ALL_MEALS" | "SELECTED_MEALS";
  selectedMeals: { id: string; name: string }[];
  preview: { futureUnlockedMeals: number; alreadyLockedMeals: number };
  createdAt: string;
}

/** Sun-first weekday headers (house calendar-grid pattern). */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Event types → token tones (no raw colors; light+dark safe) + row orbs. */
const TYPE_META: Record<string, { label: string; dot: string; orb: string; icon: typeof PartyPopper }> = {
  HOLIDAY: { label: "Holiday", dot: "bg-warning", orb: "amber", icon: PartyPopper },
  FESTIVAL: { label: "Festival", dot: "bg-primary", orb: "violet", icon: PartyPopper },
  MAINTENANCE: { label: "Maintenance", dot: "bg-danger", orb: "rose", icon: Wrench },
  CUSTOM: { label: "Custom", dot: "bg-muted-foreground/40", orb: "frost", icon: CalendarDays },
};

function typeMeta(type: string) {
  return TYPE_META[type] ?? TYPE_META.CUSTOM;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function monthRange(year: number, month1to12: number): { from: string; to: string } {
  const lastDay = new Date(year, month1to12, 0).getDate();
  return { from: `${year}-${pad2(month1to12)}-01`, to: `${year}-${pad2(month1to12)}-${pad2(lastDay)}` };
}

interface ImpactData {
  affectedMealServices: number;
  perDefinition: { id: string; name: string; count: number }[];
}

export default function AdminCalendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CalendarEventRow | null>(null);
  const [acting, setActing] = useState(false);
  const [leaveFilter, setLeaveFilter] = useState<"PENDING" | "ALL">("PENDING");
  const [approveTarget, setApproveTarget] = useState<LeaveRequestRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<LeaveRequestRow | null>(null);
  const [actingLeave, setActingLeave] = useState(false);
  const invalidate = useInvalidate();

  const range = useMemo(() => monthRange(year, month), [year, month]);
  const { data: events, isLoading, error, refetch } = useApiQuery<CalendarEventRow[]>(CAL_GET_PATH, range);
  const { data: allLeaves, refetch: refetchLeaves } = useApiQuery<LeaveRequestRow[]>(LEAVE_PATH);
  const leaveRequests = Array.isArray(allLeaves) ? allLeaves : [];
  const serverToday = todayKey();

  const leavesByDay = useMemo(() => {
    const map = new Map<string, LeaveRequestRow[]>();
    for (const l of leaveRequests) {
      if (l.status === "REJECTED" || l.status === "CANCELLED") continue;
      for (let d = new Date(`${l.startDate}T00:00:00`); d <= new Date(`${l.endDate}T00:00:00`); d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        const list = map.get(key) ?? [];
        list.push(l);
        map.set(key, list);
      }
    }
    return map;
  }, [leaveRequests]);

  const monthLeaves = useMemo(() => {
    return leaveRequests
      .filter((l) => {
        if (leaveFilter === "PENDING" && l.status !== "PENDING") return false;
        if (selectedDay) {
          return l.startDate <= selectedDay && l.endDate >= selectedDay;
        }
        return l.startDate <= range.to && l.endDate >= range.from;
      })
      .sort((a, b) => {
        const getRank = (st: string) => (st === "PENDING" ? 0 : 1);
        const rA = getRank(a.status);
        const rB = getRank(b.status);
        if (rA !== rB) return rA - rB;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [leaveRequests, leaveFilter, selectedDay, range]);

  const pendingLeaveCount = useMemo(() => {
    return leaveRequests.filter((l) => {
      if (l.status !== "PENDING") return false;
      if (selectedDay) {
        return l.startDate <= selectedDay && l.endDate >= selectedDay;
      }
      return l.startDate <= range.to && l.endDate >= range.from;
    }).length;
  }, [leaveRequests, selectedDay, range]);

  async function handleApproveLeave(reason?: string) {
    if (!approveTarget) return;
    setActingLeave(true);
    try {
      await postJson(`${LEAVE_PATH}/${approveTarget.id}/approve`, { reason });
      toast.success("Leave request approved", {
        description: `${approveTarget.residentName} · ${fmtDate(approveTarget.startDate)} to ${fmtDate(approveTarget.endDate)}`,
      });
      setApproveTarget(null);
      void refetchLeaves();
      invalidate([LEAVE_PATH, CAL_GET_PATH, "/api/v1/admin/dashboard", "/api/v1/admin/meals"]);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActingLeave(false);
    }
  }

  async function handleRejectLeave(reason?: string) {
    if (!rejectTarget) return;
    setActingLeave(true);
    try {
      await postJson(`${LEAVE_PATH}/${rejectTarget.id}/reject`, { reason });
      toast.success("Leave request rejected", {
        description: `${rejectTarget.residentName} · ${fmtDate(rejectTarget.startDate)} to ${fmtDate(rejectTarget.endDate)}`,
      });
      setRejectTarget(null);
      void refetchLeaves();
      invalidate([LEAVE_PATH, CAL_GET_PATH, "/api/v1/admin/dashboard", "/api/v1/admin/meals"]);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActingLeave(false);
    }
  }

  /* grid cells (Sun-first, whole weeks only) */
  const cells = useMemo(() => {
    const firstOffset = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const total = Math.ceil((firstOffset + daysInMonth) / 7) * 7;
    const out: { key: string; day: number; inMonth: boolean }[] = [];
    for (let i = 0; i < total; i++) {
      const dayNum = i - firstOffset + 1;
      if (dayNum < 1 || dayNum > daysInMonth) {
        out.push({ key: `pad-${i}`, day: 0, inMonth: false });
      } else {
        out.push({ key: `${year}-${pad2(month)}-${pad2(dayNum)}`, day: dayNum, inMonth: true });
      }
    }
    return out;
  }, [year, month]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventRow[]>();
    for (const e of events ?? []) {
      for (let d = new Date(`${e.startDate}T00:00:00`); d <= new Date(`${e.endDate}T00:00:00`); d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        const list = map.get(key) ?? [];
        list.push(e);
        map.set(key, list);
      }
    }
    return map;
  }, [events]);

  const listEvents = useMemo(() => {
    if (!events) return [];
    return [...events].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  }, [events]);

  const dayEvents = selectedDay ? (eventsByDay.get(selectedDay) ?? []) : listEvents;

  const isCurrentMonth = `${year}-${pad2(month)}` === serverToday.slice(0, 7);

  function shiftMonth(delta: number) {
    setSelectedDay(null);
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  }

  /** Picker pill → jump back to the current month. */
  function resetToCurrentMonth() {
    const [tY, tM] = serverToday.split("-").map(Number);
    if (tY === year && tM === month) return;
    setYear(tY);
    setMonth(tM);
    setSelectedDay(null);
  }

  async function removeEvent(reason?: string) {
    if (!deleteTarget) return;
    void reason;
    setActing(true);
    try {
      await deleteJson(`${CAL_ADMIN_PATH}/${deleteTarget.id}`);
      invalidate([CAL_GET_PATH]);
      toast.success("Event deleted", {
        description: deleteTarget.disableMeals
          ? "Meals disabled by this event become available again on the next evaluation."
          : deleteTarget.name,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
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

  return (
    <StaggerGroup className="space-y-4">
      {/* Month navigation — centered picker capsule (house pattern) */}
      <StaggerItem>
      <PickerCapsule
        onPrev={() => shiftMonth(-1)}
        onNext={() => shiftMonth(1)}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPillClick={resetToCurrentMonth}
        resettable={!isCurrentMonth}
        pillAriaLabel="Reset to current month"
      >
        <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 text-center leading-tight">
          <span className="block truncate text-sm sm:text-base font-bold text-primary">{MONTHS_LONG[month - 1]}</span>
          <span className="block truncate text-[11px] sm:text-xs text-muted-foreground">{year}</span>
        </span>
      </PickerCapsule>
      </StaggerItem>

      {/* Month grid (house calendar-grid pattern) */}
      <StaggerItem>
      <GlassCard className="p-4 sm:p-5">
        {/* Weekday headers (Sun-first) */}
        <div className="mb-2 grid grid-cols-7 gap-1 sm:gap-2">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1 text-center text-[11px] sm:text-sm font-semibold text-muted-foreground">
              {d}
            </div>
          ))}
        </div>
        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1 sm:gap-2">
          {cells.map((cell, i) => {
            if (!cell.inMonth) {
              return <span key={`pad-${i}`} aria-hidden className="aspect-square min-h-[44px] sm:min-h-[56px] md:min-h-[64px]" />;
            }
            const cellEvents = eventsByDay.get(cell.key) ?? [];
            const cellLeaves = leavesByDay.get(cell.key) ?? [];
            const isToday = cell.key === serverToday;
            const isSelected = cell.key === selectedDay;
            const isPast = cell.key < serverToday;
            return (
              <button
                key={cell.key}
                type="button"
                aria-label={`${fmtDate(cell.key)}${cellEvents.length > 0 ? ` — ${cellEvents.length} event${cellEvents.length === 1 ? "" : "s"}` : ""}${cellLeaves.length > 0 ? ` — ${cellLeaves.length} leave${cellLeaves.length === 1 ? "" : "s"}` : ""}`}
                onClick={() => setSelectedDay(isSelected ? null : cell.key)}
                className={cn(
                  "relative flex aspect-square min-h-[44px] sm:min-h-[56px] md:min-h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl text-xs sm:text-sm transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                  isToday
                    ? cn("bg-primary/15 ring-1 ring-primary/40", isSelected && "ring-2 ring-primary/60")
                    : isSelected
                      ? "glass-inset ring-2 ring-primary/50"
                      : "glass-inset hover:ring-1 hover:ring-primary/30",
                  !isToday && !isSelected && isPast && "opacity-60"
                )}
              >
                <span className={cn("font-bold text-xs sm:text-base md:text-lg", isToday || isSelected ? "text-primary" : "text-foreground")}>
                  {cell.day}
                </span>
                {(cellEvents.length > 0 || cellLeaves.length > 0) && (
                  <span className="flex items-center gap-1" aria-hidden>
                    {cellEvents.slice(0, 2).map((e) => (
                      <span
                        key={e.id}
                        className={cn(
                          "size-1.5 sm:size-2 rounded-full",
                          typeMeta(e.type).dot,
                          e.disableMeals && "ring-1 ring-foreground/30"
                        )}
                      />
                    ))}
                    {cellLeaves.length > 0 && (
                      <span
                        className="size-1.5 sm:size-2 rounded-full bg-amber-400 ring-1 ring-amber-400/40"
                        title={`${cellLeaves.length} leave request${cellLeaves.length === 1 ? "" : "s"}`}
                      />
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 sm:gap-x-6 gap-y-2 border-t border-border/40 pt-3 text-xs sm:text-sm">
          {Object.entries(TYPE_META).map(([type, m]) => (
            <span key={type} className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-muted-foreground">
              <span className={cn("size-2 rounded-full", m.dot)} aria-hidden />
              {m.label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-muted-foreground">
            <span className="size-2 rounded-full bg-amber-400 ring-1 ring-amber-400/40" aria-hidden />
            Leave requests
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-muted-foreground">
            <span className="size-2 rounded-full bg-foreground/40 ring-1 ring-foreground/30" aria-hidden />
            Meals disabled
          </span>
        </div>
      </GlassCard>
      </StaggerItem>

      {/* Primary action — Create Event centered below calendar view */}
      <StaggerItem>
      <div className="flex items-center justify-center">
        <GlassButton variant="primary" icon={<Plus />} onClick={() => setCreateOpen(true)}>
          Create Event
        </GlassButton>
      </div>
      </StaggerItem>

      {/* events list — ONE section card (meals-page anatomy): CalendarDays
          icon header + count + month-reset action, compact type-orb rows */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <CalendarDays className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold">
            {selectedDay ? `Events on ${fmtDate(selectedDay)}` : "Events this month"}
          </h3>
          {selectedDay && (
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="ml-auto text-[11px] font-semibold text-primary hover:underline"
            >
              Show whole month
            </button>
          )}
        </div>
        {isLoading ? (
          <ListSkeleton rows={3} />
        ) : dayEvents.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title={selectedDay ? "Nothing on this day" : "No events this month"}
            description={selectedDay ? "Tap another day or create a new event." : "Create holidays, festivals or maintenance windows."}
            action={
              <GlassButton variant="secondary" icon={<Plus />} onClick={() => setCreateOpen(true)}>
                Create Event
              </GlassButton>
            }
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {dayEvents.map((e) => {
                const m = typeMeta(e.type);
                return (
                  <motion.div
                    key={e.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <GlassCard className="p-3">
                      <div className="flex items-center gap-3">
                        <MealOrb icon={<m.icon />} colorToken={m.orb} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold">{e.name}</p>
                            <Chip tone="neutral">{m.label}</Chip>
                            {e.disableMeals && <Chip tone="danger">Meals disabled</Chip>}
                            {e.disableMeals && e.mealScope === "SELECTED_MEALS" && e.selectedMeals.length > 0 && (
                              <Chip tone="neutral">{e.selectedMeals.map((meal) => meal.name).join(", ")}</Chip>
                            )}
                          </div>
                          <p className="kpi-num mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <CalendarDays className="size-3" aria-hidden />
                            {e.startDate === e.endDate ? fmtDate(e.startDate) : `${fmtDate(e.startDate)} → ${fmtDate(e.endDate)}`}
                          </p>
                          {e.description && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{e.description}</p>}
                        </div>
                        <OverflowMenu
                          label={`Actions for ${e.name}`}
                          actions={[
                            { key: "delete", label: "Delete event", icon: <Trash2 />, onSelect: () => setDeleteTarget(e), destructive: true },
                          ]}
                        />
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

      {/* Leave requests section */}
      <StaggerItem>
      <GlassCard className="p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
              <CalendarClock className="size-5" aria-hidden />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">
                  {selectedDay ? `Leave requests on ${fmtDate(selectedDay)}` : "Leave requests"}
                </h3>
                {pendingLeaveCount > 0 ? (
                  <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-[11px] font-bold text-warning">
                    {pendingLeaveCount} pending
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-400">
                    All clear
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedDay
                  ? `Residents on approved or pending leave on this date`
                  : `Resident leave applications for ${MONTHS_LONG[month - 1]} ${year}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setLeaveFilter("PENDING")}
              className={cn(
                "cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-all",
                leaveFilter === "PENDING"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "glass-inset text-muted-foreground hover:text-foreground"
              )}
            >
              Pending
            </button>
            <button
              type="button"
              onClick={() => setLeaveFilter("ALL")}
              className={cn(
                "cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-all",
                leaveFilter === "ALL"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "glass-inset text-muted-foreground hover:text-foreground"
              )}
            >
              All
            </button>
          </div>
        </div>

        {monthLeaves.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={leaveFilter === "PENDING" ? "No pending leave requests" : "No leave requests"}
            description={
              selectedDay
                ? `No resident leave applications active on ${fmtDate(selectedDay)}.`
                : leaveFilter === "PENDING"
                  ? `No pending leave requests for ${MONTHS_LONG[month - 1]} ${year}.`
                  : `No leave applications recorded for this month.`
            }
          />
        ) : (
          <div className="space-y-2">
            {monthLeaves.map((leave) => (
              <div
                key={leave.id}
                className="glass-inset flex flex-col gap-3 rounded-2xl p-3.5 transition-all sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden
                    className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold text-primary"
                  >
                    {initialsOf(leave.residentName)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {leave.residentName}
                      </span>
                      {leave.roomNumber && (
                        <span className="text-xs text-muted-foreground">
                          Room {leave.roomNumber}
                        </span>
                      )}
                      <StatusBadge status={leave.status} label={leave.status.toLowerCase()} />
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-medium text-primary">
                      <Calendar className="size-3.5" aria-hidden />
                      <span>
                        {fmtDate(leave.startDate)} – {fmtDate(leave.endDate)} · {leave.dayCount}{" "}
                        {leave.dayCount === 1 ? "day" : "days"}
                      </span>
                      {leave.preview.futureUnlockedMeals > 0 && (
                        <span className="text-muted-foreground">
                          ({leave.preview.futureUnlockedMeals} unlocked meals)
                        </span>
                      )}
                    </p>
                    {leave.mealScope === "SELECTED_MEALS" && leave.selectedMeals.length > 0 && (
                      <p className="mt-1 text-[11px] font-medium text-muted-foreground">
                        Applies to: {leave.selectedMeals.map((meal) => meal.name).join(", ")}
                      </p>
                    )}
                    {leave.reason && (
                      <p className="mt-1 text-xs text-muted-foreground italic">
                        &ldquo;{leave.reason}&rdquo;
                      </p>
                    )}
                  </div>
                </div>

                {leave.status === "PENDING" && (
                  <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
                    <GlassButton
                      size="sm"
                      variant="primary"
                      icon={<CheckCircle2 className="size-3.5" />}
                      onClick={() => setApproveTarget(leave)}
                    >
                      Approve
                    </GlassButton>
                    <GlassButton
                      size="sm"
                      variant="destructive"
                      icon={<XCircle className="size-3.5" />}
                      onClick={() => setRejectTarget(leave)}
                    >
                      Reject
                    </GlassButton>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      {/* create dialog */}
      {createOpen && (
        <CreateEventDialog
          open
          onOpenChange={setCreateOpen}
          onSaved={() => invalidate([CAL_GET_PATH])}
        />
      )}

      {/* delete confirm */}
      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={`Delete "${deleteTarget.name}"`}
          description={
            deleteTarget.disableMeals
              ? "Meals disabled by this event become available again as soon as the engine re-evaluates. Historical meal rows are preserved."
              : "The event is removed from the calendar. Historical meal rows are preserved."
          }
          confirmLabel="Delete event"
          tone="destructive"
          loading={acting}
          onConfirm={() => void removeEvent()}
        />
      )}

      {/* leave approve dialog */}
      {approveTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setApproveTarget(null)}
          title={`Approve leave — ${approveTarget.residentName}`}
          description={
            <>
              <span>
                Approve leave from <strong>{fmtDate(approveTarget.startDate)}</strong> to{" "}
                <strong>{fmtDate(approveTarget.endDate)}</strong> ({approveTarget.dayCount}{" "}
                {approveTarget.dayCount === 1 ? "day" : "days"})?
              </span>
              <span className="mt-1.5 block text-xs text-muted-foreground">
                {approveTarget.mealScope === "SELECTED_MEALS"
                  ? `Only ${approveTarget.selectedMeals.map((meal) => meal.name).join(", ")} will be marked On Leave; other meals stay normal.`
                  : "Future unlocked meals in this window will automatically be marked On Leave and excluded from billing."}
              </span>
            </>
          }
          confirmLabel="Approve leave"
          tone="primary"
          loading={actingLeave}
          onConfirm={(reason) => void handleApproveLeave(reason)}
        />
      )}

      {/* leave reject dialog */}
      {rejectTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRejectTarget(null)}
          title={`Reject leave — ${rejectTarget.residentName}`}
          description="Please provide a reason for rejecting this leave request. The resident will be notified."
          confirmLabel="Reject leave"
          tone="destructive"
          requireReason
          reasonPlaceholder="Reason for rejection (required)"
          loading={actingLeave}
          onConfirm={(reason) => void handleRejectLeave(reason)}
        />
      )}
    </StaggerGroup>
  );
}

/* ------------------------------------------------------------ create form */

function CreateEventDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [type, setType] = useState("HOLIDAY");
  const [disableMeals, setDisableMeals] = useState(false);
  const [mealScope, setMealScope] = useState<"ALL_MEALS" | "SELECTED_MEALS">("ALL_MEALS");
  const [selectedMealIds, setSelectedMealIds] = useState<string[]>([]);
  const { data: mealDefinitions } = useApiQuery<MealDefinitionRow[]>("/api/v1/admin/meal-definitions");
  const mealOptions = (mealDefinitions ?? []).filter(
    (meal) => meal.active && meal.archivedAt == null && meal.mealType !== "GUEST_ONLY" && meal.defaultVisible
  );
  const impactScopeKey = [...selectedMealIds].sort().join(",");
  const [impact, setImpact] = useState<ImpactData | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const datesValid = startDate !== "" && endDate !== "" && startDate <= endDate;

  // Impact preview whenever the window + disableMeals change.
  useEffect(() => {
    if (!disableMeals || !datesValid) {
      setImpact(null);
      return;
    }
    let cancelled = false;
    setImpactLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await postJson<ImpactData>(`${CAL_ADMIN_PATH}/impact`, {
          startDate,
          endDate,
          disableMeals: true,
          mealScope,
          mealDefinitionIds: mealScope === "SELECTED_MEALS" ? selectedMealIds : [],
        });
        if (!cancelled) setImpact(res);
      } catch {
        if (!cancelled) setImpact(null);
      } finally {
        if (!cancelled) setImpactLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [disableMeals, datesValid, startDate, endDate, mealScope, impactScopeKey]);

  const scopeValid = !disableMeals || mealScope === "ALL_MEALS" || selectedMealIds.length > 0;
  const valid = name.trim().length >= 2 && datesValid && scopeValid;

  async function submit() {
    setSaving(true);
    setFields({});
    try {
      await postJson(CAL_ADMIN_PATH, {
        name: name.trim(),
        description: description.trim() || undefined,
        startDate,
        endDate,
        type,
        disableMeals,
        mealScope: disableMeals ? mealScope : "ALL_MEALS",
        mealDefinitionIds: disableMeals && mealScope === "SELECTED_MEALS" ? selectedMealIds : [],
      });
      toast.success("Event created", {
        description: disableMeals && impact ? `${impact.affectedMealServices} meal services will be disabled.` : name.trim(),
      });
      onSaved();
      onOpenChange(false);
      setName("");
      setDescription("");
      setStartDate("");
      setEndDate("");
      setDisableMeals(false);
      setMealScope("ALL_MEALS");
      setSelectedMealIds([]);
      setImpact(null);
    } catch (err) {
      if (err instanceof ApiClientError && err.fields) setFields(err.fields);
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell5
      open={open}
      onOpenChange={onOpenChange}
      title="Create event"
      description="Events mark the calendar. Only enable meal disabling when the kitchen will truly be closed — it overrides resident choices."
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" icon={<Plus />} loading={saving} disabled={!valid} onClick={() => void submit()}>
            Create event
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Durga Puja" maxLength={90} error={fields.name} />
        <TextAreaField label="Description (optional)" value={description} onChange={setDescription} rows={2} maxLength={500} placeholder="What's happening…" />
        <div className="grid grid-cols-2 gap-2.5">
          <TextField label="Starts" type="date" value={startDate} onChange={setStartDate} error={fields.startDate} />
          <TextField label="Ends" type="date" value={endDate} onChange={setEndDate} error={fields.endDate ?? (startDate && endDate && startDate > endDate ? "End is before start." : undefined)} />
        </div>
        <SelectField
          label="Type"
          value={type}
          onChange={setType}
          options={[
            { value: "HOLIDAY", label: "Holiday" },
            { value: "FESTIVAL", label: "Festival" },
            { value: "MAINTENANCE", label: "Maintenance" },
            { value: "CUSTOM", label: "Custom" },
          ]}
        />
        <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Disable meals</p>
            <p className="text-[11px] text-muted-foreground">Disable every meal or only selected meal types in this window.</p>
          </div>
          <GlassToggle checked={disableMeals} onChange={(next) => setDisableMeals(next)} label="Disable meals in this window" />
        </div>

        {disableMeals && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setMealScope("ALL_MEALS"); setSelectedMealIds([]); }}
                className={cn(
                  "glass-inset min-h-10 rounded-md px-3 text-sm font-medium transition-all",
                  mealScope === "ALL_MEALS" ? "ring-2 ring-ring" : "text-muted-foreground hover:text-foreground"
                )}
              >
                All meals
              </button>
              <button
                type="button"
                onClick={() => setMealScope("SELECTED_MEALS")}
                className={cn(
                  "glass-inset min-h-10 rounded-md px-3 text-sm font-medium transition-all",
                  mealScope === "SELECTED_MEALS" ? "ring-2 ring-ring" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Selected meals
              </button>
            </div>
            {mealScope === "SELECTED_MEALS" && (
              <div className="glass-inset grid gap-1 rounded-md p-2 sm:grid-cols-2">
                {mealOptions.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground sm:col-span-2">No selectable meals are configured.</p>
                ) : (
                  mealOptions.map((meal) => {
                    const checked = selectedMealIds.includes(meal.id);
                    return (
                      <button
                        key={meal.id}
                        type="button"
                        aria-pressed={checked}
                        onClick={() =>
                          setSelectedMealIds((current) =>
                            current.includes(meal.id) ? current.filter((id) => id !== meal.id) : [...current, meal.id]
                          )
                        }
                        className={cn(
                          "flex min-h-9 items-center justify-between rounded-md px-3 text-left text-sm transition-colors",
                          checked ? "bg-primary/12 font-medium text-primary" : "hover:bg-foreground/5"
                        )}
                      >
                        <span className="truncate">{meal.name}</span>
                        <span className="ml-2 text-[11px]">{checked ? "Selected" : "Add"}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* impact preview */}
        {disableMeals && datesValid && scopeValid && (
          <div className="rounded-md border border-warning/30 bg-warning/8 p-3.5" role="status">
            <p className="text-[12px] font-semibold text-warning">Impact preview</p>
            {impactLoading ? (
              <p className="mt-1 text-[12px] text-muted-foreground">Counting affected services…</p>
            ) : impact ? (
              <>
                <p className="mt-1 text-[12px] leading-relaxed">
                  This will disable <span className="kpi-num font-semibold">{impact.affectedMealServices}</span> meal
                  service{impact.affectedMealServices === 1 ? "" : "s"} from{" "}
                  <span className="font-medium">{fmtDate(startDate)}</span> to{" "}
                  <span className="font-medium">{fmtDate(endDate)}</span>.
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {impact.perDefinition.map((d) => `${d.name} ×${d.count}`).join(" · ")}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[12px] text-muted-foreground">Impact is being calculated — review before saving.</p>
            )}
          </div>
        )}
      </div>
    </DialogShell5>
  );
}

/* ------------------------------------------------------------ dialog shell */

function DialogShell5({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("glass-strong rounded-2xl border-0 p-0", wide ? "sm:max-w-2xl" : "sm:max-w-md")}>
        <div className="flex max-h-[85vh] flex-col">
          <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">{title}</DialogTitle>
            {description && (
              <DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </DialogDescription>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
          {footer && (
            <div className="safe-b flex flex-wrap items-center justify-end gap-2 border-t border-border/50 px-5 py-4 sm:px-6">
              {footer}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
