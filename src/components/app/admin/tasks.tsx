"use client";

/**
 * Admin Tasks — assign work and verify submitted purchases.
 * BoardOps composition: action bar (Assign Task) → status KPIs → filter
 * chips → review queue → status-tinted task rows (scroll-capped).
 * GET /api/v1/admin/tasks?status= · POST /admin/tasks ·
 * POST /admin/task-submissions/:id/approve|reject
 * (Review queue derived from tasks with status SUBMITTED — each embeds
 * its submission with items + proof.)
 */

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  ListChecks,
  Package,
  Plus,
  ShoppingCart,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import SectionHeading from "@/components/glass/SectionHeading";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { ApiClientError } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { errMessage, useInvalidate, useApiMetaQuery } from "./_shared/api";
import { MoneyField, SelectField, TextAreaField, TextField, moneyProblem } from "./_shared/fields";
import { Chip, DetailDialog, FilterChips, KeyValue, KpiGrid, ProofImage, type KpiSpec } from "./_shared/chrome";
import { fmtDate, fmtDateTime, fmtMinor, todayKey } from "./_shared/format";
import type { ResidentRow, TaskRow } from "./_shared/types";

const TASKS_PATH = "/api/v1/admin/tasks";
const SUBMISSIONS_PATH = "/api/v1/admin/task-submissions";

function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2026, (m ?? 1) - 1, 1));
}

const STATUS_CHIPS = [
  { value: "SUBMITTED", label: "Needs Review", review: true },
  { value: "ALL", label: "All" },
  { value: "ASSIGNED", label: "Assigned" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "APPROVED", label: "Completed" },
  { value: "REJECTED", label: "Rejected" },
];

const TASK_TYPE_LABELS: Record<string, string> = {
  MARKET_PURCHASE: "Market task",
  GENERAL: "Normal task",
};

/** The two assignable task kinds — the admin picks ONE when assigning. */
interface TaskTypeOption {
  value: "MARKET_PURCHASE" | "GENERAL";
  label: string;
  description: string;
  placeholder: string;
}

const TASK_TYPES: TaskTypeOption[] = [
  {
    value: "GENERAL",
    label: "Normal task",
    description: "Everyday help around the mess — e.g. a water container needed in the kitchen.",
    placeholder: "e.g. Water container needed in the kitchen",
  },
  {
    value: "MARKET_PURCHASE",
    label: "Market task",
    description: "Shopping with a list and costs — the approved submission becomes an expense.",
    placeholder: "e.g. Weekly vegetable market run",
  },
];

function taskTypeOption(value: string): TaskTypeOption {
  return TASK_TYPES.find((t) => t.value === value) ?? TASK_TYPES[0];
}

/** Statuses that still need action (not finished/rejected). */
const ACTIVE_STATUSES = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "SUBMITTED"]);

/** Status-tinted icon tile (BoardOps task-row pattern). */
const STATUS_TILE: Record<string, string> = {
  ASSIGNED: "border-primary/28 bg-primary/12 text-primary",
  ACCEPTED: "border-success/30 bg-success/12 text-success",
  IN_PROGRESS: "border-warning/30 bg-warning/14 text-warning",
  SUBMITTED: "border-warning/30 bg-warning/14 text-warning",
  APPROVED: "border-success/30 bg-success/12 text-success",
  REJECTED: "border-danger/30 bg-danger/12 text-danger",
  REJECTED_BY_ADMIN: "border-danger/30 bg-danger/12 text-danger",
};

function statusTile(status: string): string {
  return STATUS_TILE[status] ?? "border-border bg-muted/60 text-muted-foreground";
}

function taskOrbColor(status: string): "emerald" | "rose" | "amber" | "frost" {
  switch (status) {
    case "APPROVED":
      return "emerald";
    case "REJECTED":
    case "REJECTED_BY_ADMIN":
      return "rose";
    case "SUBMITTED":
    case "IN_PROGRESS":
      return "amber";
    case "ASSIGNED":
    case "ACCEPTED":
    default:
      return "frost";
  }
}

function taskTileIcon(taskType: string) {
  return taskType === "MARKET_PURCHASE" ? <ShoppingCart aria-hidden /> : <ClipboardList aria-hidden />;
}

/** Compact type chip with its lucide icon (BoardOps pattern). */
function TaskTypeChip({ taskType }: { taskType: string }) {
  const market = taskType === "MARKET_PURCHASE";
  const Icon = market ? ShoppingCart : ClipboardList;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
        market
          ? "border-warning/35 bg-warning/14 text-warning"
          : "border-primary/28 bg-primary/10 text-primary"
      )}
    >
      <Icon className="size-3" aria-hidden />
      {TASK_TYPE_LABELS[taskType] ?? taskType}
    </span>
  );
}

/** The two-option task type picker (BoardOps option tiles). */
function TaskTypeTiles({
  value,
  onChange,
}: {
  value: "MARKET_PURCHASE" | "GENERAL";
  onChange: (value: "MARKET_PURCHASE" | "GENERAL") => void;
}) {
  return (
    <div role="radiogroup" aria-label="Task type" className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
      {TASK_TYPES.map((t) => {
        const active = value === t.value;
        const Icon = t.value === "MARKET_PURCHASE" ? ShoppingCart : ClipboardList;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(t.value)}
            className={cn(
              "glass-inset flex cursor-pointer items-start gap-3 rounded-md p-3.5 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active ? "ring-2 ring-primary/55" : "hover:bg-foreground/5"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-xl border [&_svg]:size-5",
                active
                  ? "border-primary/30 bg-primary/12 text-primary shadow-[0_6px_18px_-8px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
                  : "border-border bg-muted/50 text-muted-foreground"
              )}
            >
              <Icon />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{t.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{t.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function AdminTasks() {
  const [status, setStatus] = useState("SUBMITTED");
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const currentMonthKey = todayKey().slice(0, 7);
  const [monthKey, setMonthKey] = useState<string>(currentMonthKey);

  const { data: envelope, isLoading, error, refetch } = useApiMetaQuery<TaskRow[]>(TASKS_PATH, {
    status: status === "ALL" ? undefined : status,
    month: monthKey,
  });
  const tasks = envelope?.data ?? [];
  const meta = envelope?.meta ?? {};
  const countsByStatus = (meta.countsByStatus as Record<string, number> | undefined) ?? {};

  // review queue = SUBMITTED tasks (the task-submissions endpoint is a thin
  // wrapper over the same rows; embedding avoids the second round-trip).
  const reviewQueue = tasks.filter((t) => t.status === "SUBMITTED" && t.submission && t.submission.status === "SUBMITTED");

  // Sorting a copied query result is cheap at this list size and avoids manual
  // memoization that React Compiler cannot safely preserve for this dependency.
  const sortedTasks = [...tasks].sort((a, b) => {
    const getRank = (st: string) => {
      if (st === "SUBMITTED") return 0; // Needs admin review
      if (st === "IN_PROGRESS" || st === "ACCEPTED" || st === "ASSIGNED") return 1; // Active
      return 2; // Completed / Rejected
    };
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;

    if (rA === 1) {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const chips = STATUS_CHIPS.map((c) => ({
    value: c.value,
    label: c.label,
    count: c.value === "ALL" ? undefined : countsByStatus[c.value],
  }));

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

  const openCount = (countsByStatus.ASSIGNED ?? 0) + (countsByStatus.ACCEPTED ?? 0);
  const doneCount = countsByStatus.APPROVED ?? 0;
  const overdueCount = tasks.filter(
    (t) => ACTIVE_STATUSES.has(t.status) && t.dueDate && t.dueDate < todayKey()
  ).length;

  const kpis: KpiSpec[] = [
    {
      label: "Open",
      value: String(openCount),
      sub: "Assigned",
      icon: <ListChecks />,
      tone: "primary",
      glow: "primary",
    },
    {
      label: "Done",
      value: String(doneCount),
      sub: "Approved",
      icon: <CheckCircle2 />,
      tone: "success",
      glow: "success",
    },
    {
      label: "Overdue",
      value: String(overdueCount),
      sub: "Past due",
      icon: <TriangleAlert />,
      tone: "danger",
      glow: "danger",
    },
  ];

  return (
    <StaggerGroup className="space-y-4">
      {/* Month navigation — centered picker capsule */}
      <StaggerItem>
      <PickerCapsule
        onPrev={() => setMonthKey(shiftMonthKey(monthKey, -1))}
        onNext={() => setMonthKey(shiftMonthKey(monthKey, 1))}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPillClick={() => setMonthKey(currentMonthKey)}
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

      {/* KPIs — status overview (3-column layout like meals) */}
      <StaggerItem>
      <KpiGrid kpis={kpis} loading={isLoading && !envelope} className="grid grid-cols-3 gap-2 sm:gap-3" />
      </StaggerItem>

      {/* Action bar — primary action centered */}
      <StaggerItem>
      <div className="flex items-center justify-center">
        <GlassButton variant="primary" icon={<Plus />} onClick={() => setAssignOpen(true)}>
          Assign Task
        </GlassButton>
      </div>
      </StaggerItem>

      {/* review queue */}
      <StaggerItem>
      {status === "ALL" && reviewQueue.length > 0 && (
        <section className="space-y-3">
          <SectionHeading>Needs your review · {reviewQueue.length}</SectionHeading>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {reviewQueue.map((task) => (
              <SubmissionReviewCard key={task.id} task={task} tz={tz} onDone={() => invalidate([TASKS_PATH, "/api/v1/admin/expenses", "/api/v1/admin/dashboard"])} />
            ))}
          </div>
        </section>
      )}
      </StaggerItem>

      {/* task list with outer border */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ClipboardList className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">All tasks</h3>
        </div>

        <div className="mb-3">
          <FilterChips chips={chips} value={status} onChange={setStatus} layoutId="admin-tasks-chips" />
        </div>

        {isLoading && !envelope ? (
          <ListSkeleton rows={4} />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={status === "ALL" ? "No tasks yet" : `No ${STATUS_CHIPS.find((c) => c.value === status)?.label.toLowerCase() ?? ""} tasks`}
            description={
              status === "ALL"
                ? "Assign market purchases or general work to residents."
                : "Nothing here right now — try another filter."
            }
            action={
              status === "ALL" ? (
                <GlassButton variant="secondary" icon={<Plus />} onClick={() => setAssignOpen(true)}>
                  Assign Task
                </GlassButton>
              ) : undefined
            }
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {sortedTasks.map((task, i) => {
                const orbColor = taskOrbColor(task.status);
                const TaskIcon = task.taskType === "MARKET_PURCHASE" ? ShoppingCart : ClipboardList;
                return (
                  <motion.div
                    key={task.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2, ease: "easeOut", delay: Math.min(i * 0.04, 0.2) }}
                  >
                    <GlassCard className="overflow-hidden rounded-2xl">
                    <div
                      className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                      onClick={() => setSelectedTask(task)}
                    >
                      {/* Top row: Identity & Assigned (Left), Date/Amount (Right) — symmetrical balance */}
                      <div className="flex h-10 items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <MealOrb icon={<TaskIcon />} colorToken={orbColor} size="sm" />
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-foreground tracking-tight" title={task.description}>
                              {task.description}
                            </h4>
                            <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <span>{task.residentName}</span>
                              {task.roomNumber && <span>· Room {task.roomNumber}</span>}
                            </p>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          {task.submission?.claimedTotalMinor ? (
                            <>
                              <Money minor={task.submission.claimedTotalMinor} className="text-base sm:text-lg font-bold text-foreground block leading-tight" />
                              <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                                claimed
                              </span>
                            </>
                          ) : task.dueDate ? (
                            <>
                              <span className="text-xs sm:text-sm font-bold text-foreground block leading-tight">
                                {fmtDate(task.dueDate)}
                              </span>
                              <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                                due date
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-xs sm:text-sm font-medium text-muted-foreground block leading-tight">
                                {fmtDate(task.createdAt)}
                              </span>
                              <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                                assigned
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Bottom row: Badges on left, Details in a pill on right — strictly 1 row for symmetrical heights */}
                      <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <StatusBadge status={task.status} />
                          <TaskTypeChip taskType={task.taskType} />
                          {task.items.length > 0 && (
                            <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                              · {task.items.length} item{task.items.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>

                        {/* Details button in a tactile glass pill */}
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTask(task);
                          }}
                          aria-label={`Open details for task ${task.description}`}
                          className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span>Details</span>
                          <ChevronRight className="size-3" aria-hidden />
                        </motion.button>
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

      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          tz={tz}
          onClose={() => setSelectedTask(null)}
          onReviewDone={() => invalidate([TASKS_PATH, "/api/v1/admin/expenses", "/api/v1/admin/dashboard"])}
        />
      )}

      {assignOpen && (
        <AssignTaskDialog
          open
          onOpenChange={setAssignOpen}
          onSaved={() => invalidate([TASKS_PATH, "/api/v1/admin/dashboard"])}
        />
      )}
    </StaggerGroup>
  );
}

/* ------------------------------------------------------------ task detail dialog */

function TaskDetailDialog({
  task,
  tz,
  onClose,
  onReviewDone,
}: {
  task: TaskRow | null;
  tz: string;
  onClose: () => void;
  onReviewDone: () => void;
}) {
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [acting, setActing] = useState(false);

  if (!task) return null;
  const currentTask = task;
  const sub = currentTask.submission;
  const canReview = currentTask.status === "SUBMITTED" && sub && sub.status === "SUBMITTED";

  async function runReview(kind: "approve" | "reject", reason?: string) {
    if (!sub) return;
    setActing(true);
    try {
      await postJson(`${SUBMISSIONS_PATH}/${sub.id}/${kind}`, kind === "reject" ? { reason } : reason ? { reason } : {});
      onReviewDone();
      toast.success(
        kind === "approve"
          ? currentTask.taskType === "MARKET_PURCHASE"
            ? "Expense created and posted"
            : "Normal task completion approved"
          : "Submission rejected",
        { description: `${currentTask.residentName} · ${currentTask.description}` }
      );
      setConfirm(null);
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
        open
        onOpenChange={(open) => !open && onClose()}
        title={currentTask.description}
        description={`Assigned to ${currentTask.residentName}${currentTask.roomNumber ? ` · Room ${currentTask.roomNumber}` : ""}`}
        wide
        footer={
          canReview ? (
            <>
              <GlassButton variant="destructive" icon={<XCircle className="size-4" />} onClick={() => setConfirm("reject")} disabled={acting}>
                Reject
              </GlassButton>
              <GlassButton variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setConfirm("approve")} disabled={acting}>
                Approve
              </GlassButton>
            </>
          ) : (
            <GlassButton variant="ghost" onClick={onClose}>
              Close
            </GlassButton>
          )
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Details</p>
            <div className="space-y-0.5">
              <KeyValue label="Status" value={<StatusBadge status={currentTask.status} />} />
              <KeyValue label="Task type" value={<TaskTypeChip taskType={currentTask.taskType} />} />
              <KeyValue label="Assigned to" value={`${currentTask.residentName}${currentTask.roomNumber ? ` · Room ${currentTask.roomNumber}` : ""}`} />
              <KeyValue label="Assigned date" value={fmtDateTime(currentTask.createdAt, tz)} />
              {currentTask.dueDate && <KeyValue label="Due date" value={fmtDate(currentTask.dueDate)} />}
              {currentTask.notes && <KeyValue label="Notes" value={currentTask.notes} />}
            </div>
          </div>

          {currentTask.items && currentTask.items.length > 0 && (
            <div className="border-t border-border/20 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Items ({currentTask.items.length})
              </p>
              <div className="space-y-1.5">
                {currentTask.items.map((item) => (
                  <div key={item.id} className="glass-inset flex items-center justify-between rounded-xl px-3 py-2 text-xs">
                    <span className="font-medium text-foreground">{item.itemName}</span>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {item.expectedQuantity && <span>qty: {item.expectedQuantity} {item.unit ?? ""}</span>}
                      {item.estimatedUnitPriceMinor != null && (
                        <span className="font-semibold text-foreground">
                          est. <Money minor={item.estimatedUnitPriceMinor} />
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sub && (
            <div className="border-t border-border/20 pt-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Submission</p>
              <div className="space-y-0.5">
                {currentTask.taskType === "MARKET_PURCHASE" && (
                  <KeyValue label="Claimed total" value={<Money minor={sub.claimedTotalMinor} className="font-bold text-foreground" />} />
                )}
                <KeyValue label="Submitted on" value={fmtDateTime(sub.submittedAt, tz)} />
                {sub.comment && <KeyValue label="Comment" value={sub.comment} />}
                {currentTask.adminReviewReason && <KeyValue label="Review note" value={currentTask.adminReviewReason} />}
              </div>
              {sub.proofFileId && (
                <div className="mt-2.5">
                  <p className="text-xs text-muted-foreground mb-1.5 font-medium">
                    {currentTask.taskType === "MARKET_PURCHASE" ? "Proof of purchase" : "Completion proof"}
                  </p>
                  <ProofImage fileId={sub.proofFileId} alt={`Proof for ${currentTask.description}`} />
                </div>
              )}
            </div>
          )}
        </div>
      </DetailDialog>

      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={confirm === "approve" ? "Approve submission" : "Reject submission"}
          description={
            confirm === "approve"
              ? currentTask.taskType === "MARKET_PURCHASE"
                ? `Approve ${currentTask.residentName}'s purchase of ${sub ? fmtMinor(sub.claimedTotalMinor) : ""}? An expense will be created and posted.`
                : `Approve ${currentTask.residentName}'s Normal Task completion? No expense or ledger entry will be created.`
              : `Reject ${currentTask.residentName}'s submission? Please provide a reason.`
          }
          confirmLabel={
            confirm === "approve"
              ? currentTask.taskType === "MARKET_PURCHASE"
                ? "Approve & post expense"
                : "Approve completion"
              : "Reject submission"
          }
          tone={confirm === "approve" ? "primary" : "destructive"}
          requireReason={confirm === "reject"}
          loading={acting}
          onConfirm={(reason) => void runReview(confirm, reason)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ review card */

function SubmissionReviewCard({ task, tz, onDone }: { task: TaskRow; tz: string; onDone: () => void }) {
  const sub = task.submission!;
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [acting, setActing] = useState(false);

  async function run(kind: "approve" | "reject", reason?: string) {
    setActing(true);
    try {
      await postJson(`${SUBMISSIONS_PATH}/${sub.id}/${kind}`, kind === "reject" ? { reason } : reason ? { reason } : {});
      onDone();
      toast.success(
        kind === "approve"
          ? task.taskType === "MARKET_PURCHASE"
            ? "Expense created and posted"
            : "Normal task completion approved"
          : "Submission rejected",
        { description: `${task.residentName} · ${task.description}` }
      );
      setConfirm(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  return (
    <GlassCard className="space-y-3.5 p-4">
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md border [&_svg]:size-[18px]",
            statusTile("SUBMITTED")
          )}
        >
          {taskTileIcon(task.taskType)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{task.description}</p>
            <StatusBadge status="SUBMITTED" className="shrink-0" />
          </div>
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {task.residentName}
            {task.roomNumber ? ` · Room ${task.roomNumber}` : ""}
          </p>
        </div>
      </div>

      {sub.comment && <p className="text-[12px] leading-relaxed text-muted-foreground">"{sub.comment}"</p>}

      {task.taskType === "MARKET_PURCHASE" ? (
        <div className="glass-inset rounded-md p-3">
          <div className="space-y-1">
            {sub.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{item.itemName}</span>
                  <span className="kpi-num text-muted-foreground">
                    {" "}
                    · {item.quantity} {item.unit ?? "unit"} × <Money minor={item.unitPriceMinor} plain />
                  </span>
                </span>
                <Money minor={item.lineTotalMinor} className="shrink-0 font-semibold" />
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-sm font-semibold">
            <span>Claimed total</span>
            <Money minor={sub.claimedTotalMinor} />
          </div>
        </div>
      ) : (
        <div className="glass-inset rounded-md p-3 text-[12px] text-muted-foreground">
          <p className="font-semibold text-foreground">Normal Task completion · non-financial</p>
          <p className="mt-1">Approve after verifying the work. No Expense or ledger entry will be created.</p>
        </div>
      )}

      <ProofImage fileId={sub.proofFileId} alt={`Proof for ${task.description}`} className="h-24" />

      <p className="kpi-num text-[11px] text-muted-foreground/75">Submitted {fmtDateTime(sub.submittedAt, tz)}</p>

      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="destructive" size="sm" icon={<XCircle />} onClick={() => setConfirm("reject")}>
          Reject
        </GlassButton>
        <GlassButton variant="primary" size="sm" icon={<CheckCircle2 />} onClick={() => setConfirm("approve")}>
          {task.taskType === "MARKET_PURCHASE" ? "Approve & post expense" : "Approve completion"}
        </GlassButton>
      </div>

      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={confirm === "approve" ? "Approve submission" : "Reject submission"}
          description={
            confirm === "approve" ? (
              task.taskType === "MARKET_PURCHASE" ? (
                <>
                  An official expense is created from these items (totals recomputed server-side), the money is posted to
                  the ledger, and {task.residentName} is notified. Duplicate posting is impossible — the submission links
                  to exactly one expense.
                  <span className="mt-2 block font-medium">
                    {task.description} · claimed <Money minor={sub.claimedTotalMinor} />
                  </span>
                </>
              ) : (
                <>
                  Approve this Normal Task completion after verifying the work. No Expense or ledger entry is created.
                  <span className="mt-2 block font-medium">{task.description}</span>
                </>
              )
            ) : (
              <>
                {task.residentName} is notified with your reason. This submission closes; assign a new task if the work must be retried.
                <span className="mt-2 block font-medium">{task.description}</span>
              </>
            )
          }
          confirmLabel={confirm === "approve" ? "Approve" : "Reject"}
          tone={confirm === "approve" ? "primary" : "destructive"}
          requireReason={confirm === "reject"}
          loading={acting}
          onConfirm={(reason) => void run(confirm, reason)}
        />
      )}
    </GlassCard>
  );
}

/* ----------------------------------------------------------- assign dialog */

interface DraftTaskItem {
  key: string;
  itemName: string;
  expectedQuantity: string;
  unit: string;
  estimatedUnitPrice: string;
}

function draftTaskItem(): DraftTaskItem {
  return { key: crypto.randomUUID(), itemName: "", expectedQuantity: "1", unit: "kg", estimatedUnitPrice: "" };
}

function AssignTaskDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [taskType, setTaskType] = useState<"MARKET_PURCHASE" | "GENERAL">("MARKET_PURCHASE");
  const [residentId, setResidentId] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DraftTaskItem[]>([draftTaskItem()]);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const residentsQuery = useApiQuery<ResidentRow[]>("/api/v1/admin/residents");
  const activeResidents = (residentsQuery.data ?? []).filter((r) => r.status === "ACTIVE");

  // Market tasks validate their item estimates; NORMAL tasks carry no items
  // (the items editor is hidden) so they must never be blocked by it.
  const itemsValid =
    taskType === "GENERAL" ||
    items.every(
      (i) =>
        i.itemName.trim().length > 0 &&
        Number(i.expectedQuantity) > 0 &&
        (i.estimatedUnitPrice.trim() === "" || moneyProblem(i.estimatedUnitPrice) === null)
    );
  const valid = residentId !== "" && description.trim().length >= 3 && itemsValid;

  async function submit() {
    setSaving(true);
    setFields({});
    try {
      await postJson(TASKS_PATH, {
        taskType,
        description: description.trim(),
        assignedResidentId: residentId,
        dueDate: dueDate || undefined,
        notes: notes.trim() || undefined,
        items:
          taskType === "GENERAL"
            ? []
            : items
                .filter((i) => i.itemName.trim() !== "" || i.estimatedUnitPrice.trim() !== "")
                .map((i) => ({
                  itemName: i.itemName.trim(),
                  expectedQuantity: Number(i.expectedQuantity),
                  unit: i.unit.trim() || undefined,
                  estimatedUnitPriceMinor: i.estimatedUnitPrice.trim() || undefined,
                })),
      });
      toast.success("Task assigned", { description: "The resident is notified and can accept it." });
      onSaved();
      onOpenChange(false);
      setDescription("");
      setNotes("");
      setItems([draftTaskItem()]);
      setResidentId("");
      setDueDate("");
    } catch (err) {
      if (err instanceof ApiClientError && err.fields) setFields(err.fields);
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell4
      open={open}
      onOpenChange={onOpenChange}
      title="Assign task"
      description={
        taskType === "MARKET_PURCHASE"
          ? "Market task: the resident shops with a list, submits items + receipt, and your approval posts the expense."
          : "Normal task: the resident accepts, does the work, and marks it done — no costs involved."
      }
      wide
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" icon={<Plus />} loading={saving} disabled={!valid} onClick={() => void submit()}>
            Assign {taskTypeOption(taskType).label.toLowerCase()}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Task type</p>
          <TaskTypeTiles value={taskType} onChange={setTaskType} />
        </div>

        <SelectField
          label="Resident"
          value={residentId}
          onChange={setResidentId}
          placeholder="Choose a resident…"
          options={activeResidents.map((r) => ({
            value: r.id,
            label: `${r.profile.fullName}${r.profile.roomNumber ? ` · ${r.profile.roomNumber}` : ""}`,
          }))}
          error={fields.assignedResidentId}
        />

        <TextAreaField
          label="Description"
          value={description}
          onChange={setDescription}
          rows={2}
          maxLength={500}
          placeholder={taskTypeOption(taskType).placeholder}
          error={fields.description}
        />

        <div className="grid grid-cols-2 gap-2.5">
          <TextField label="Due date (optional)" type="date" value={dueDate} onChange={setDueDate} />
        </div>

        {taskType === "MARKET_PURCHASE" && (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Items to buy (estimates)</p>
            <div className="space-y-2.5">
              <AnimatePresence initial={false}>
                {items.map((item, idx) => (
                  <motion.div
                    key={item.key}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                    className="glass-inset space-y-2.5 rounded-md p-3"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Item {idx + 1}</p>
                      {items.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove item ${idx + 1}`}
                          onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      )}
                    </div>
                    <TextField label="Name" value={item.itemName} onChange={(v) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, itemName: v } : i)))} placeholder="e.g. Mixed vegetables" maxLength={120} />
                    <div className="grid grid-cols-2 gap-2.5">
                      <TextField label="Quantity" value={item.expectedQuantity} inputMode="decimal" onChange={(v) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, expectedQuantity: v } : i)))} placeholder="20" />
                      <TextField label="Unit" value={item.unit} onChange={(v) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, unit: v } : i)))} placeholder="kg" maxLength={20} />
                    </div>
                    <MoneyField
                      label="Est. unit price (optional)"
                      value={item.estimatedUnitPrice}
                      onChange={(v) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, estimatedUnitPrice: v } : i)))}
                      placeholder="85.00"
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <GlassButton variant="secondary" size="sm" className="mt-2.5" icon={<Plus />} onClick={() => setItems((prev) => [...prev, draftTaskItem()])} disabled={items.length >= 50}>
              Add item
            </GlassButton>
          </div>
        )}

        <TextAreaField
          label="Notes for the resident (optional)"
          value={notes}
          onChange={setNotes}
          rows={2}
          maxLength={1000}
          placeholder={taskType === "MARKET_PURCHASE" ? "Where to buy, brands, timing…" : "Any details that help — timing, location…"}
        />

        {taskType === "MARKET_PURCHASE" && (
          <div className="flex items-center gap-2.5 rounded-md bg-primary/8 p-3.5">
            <Package className="size-4 shrink-0 text-primary" aria-hidden />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Estimates are guidance only — the resident submits actual prices and quantities, and the approved expense is
              recomputed server-side.
            </p>
          </div>
        )}
        {taskType === "GENERAL" && (
          <div className="flex items-center gap-2.5 rounded-md bg-primary/8 p-3.5">
            <ClipboardList className="size-4 shrink-0 text-primary" aria-hidden />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Normal tasks have no costs — the resident marks the work done, and you verify it in one tap.
            </p>
          </div>
        )}
      </div>
    </DialogShell4>
  );
}

/* ------------------------------------------------------------ dialog shell */

function DialogShell4({
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
