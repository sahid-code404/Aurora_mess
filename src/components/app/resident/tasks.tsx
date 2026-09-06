"use client";

/**
 * Resident Tasks (#/app/tasks) — BoardOps composition matching Admin Tasks:
 * Month picker capsule → 3-column status KPIs (Open, Done, Overdue) →
 * ONE "My tasks" section card (ClipboardList icon header, search + status
 * pills INSIDE) holding method/task-orb rows with symmetrical 2-row balance,
 * tactile Details button, task review/submission sheets, and inline actions.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUpRight,
  Calendar,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  Hourglass,
  ListChecks,
  Package,
  Paperclip,
  PartyPopper,
  Plus,
  ShoppingCart,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { useSession } from "@/hooks/use-session";
import { useApiQuery } from "@/hooks/use-api-query";
import GlassCard from "@/components/glass/GlassCard";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import { KpiCard } from "@/components/glass/KpiCard";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import StatusBadge from "@/components/glass/StatusBadge";
import GlassButton from "@/components/glass/GlassButton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import { EmptyState } from "@/components/glass/EmptyState";
import { ErrorState } from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropletFilterChips } from "@/components/glass/DropletFilterChips";

import { apiJson, apiMultipart, useInvalidateResident, RESIDENT_KEYS } from "./_shared/api";
import { broadcastNotification } from "@/lib/broadcast";
import { dateKeyInTz, formatDateTimeInTz, formatMinor, friendlyError, todayKeyInTz } from "./_shared/format";
import {
  AmountInput,
  FileProofInput,
  GlassField,
  GlassInput,
  GlassTextarea,
  SearchInput,
  SheetDialog,
  SheetFooterActions,
  proofProblems,
} from "./_shared/ui";
import type { TaskDto } from "./_shared/types";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ------------------------------ month helpers ------------------------------ */

function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2026, (m ?? 1) - 1, 1));
}

/* ------------------------------ task chips & tints ------------------------- */

const TASK_TYPE_LABELS: Record<string, string> = {
  MARKET_PURCHASE: "Market task",
  GENERAL: "Normal task",
};

function TaskTypeChip({ taskType }: { taskType: string }) {
  const market = taskType === "MARKET_PURCHASE";
  const Icon = market ? ShoppingCart : ClipboardList;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-pill border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
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

function taskOrbColor(status: string): "emerald" | "rose" | "amber" | "frost" {
  switch (status) {
    case "APPROVED":
      return "emerald";
    case "REJECTED":
    case "REJECTED_BY_ADMIN":
      return "rose";
    case "CANCELLED":
      return "frost";
    case "SUBMITTED":
    case "IN_PROGRESS":
      return "amber";
    case "ASSIGNED":
    case "ACCEPTED":
    default:
      return "frost";
  }
}

const STATUS_CHIPS = [
  { value: "ASSIGNED", label: "Assigned" },
  { value: "ALL", label: "All" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Completed" },
  { value: "REJECTED", label: "Declined" },
  { value: "REJECTED_BY_ADMIN", label: "Admin Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

/* --------------------------------- proof preview --------------------------- */

function ProofImage({
  fileId,
  alt,
  className,
}: {
  fileId: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!fileId || failed) {
    return (
      <div
        className={cn(
          "glass-inset flex h-32 w-full items-center justify-center rounded-xl text-muted-foreground [&_svg]:size-8",
          className
        )}
      >
        <FileText aria-hidden />
      </div>
    );
  }
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border/40 bg-background/40", className)}>
      <img
        src={`/api/v1/files/${fileId}`}
        alt={alt}
        className="max-h-72 w-full object-contain rounded-xl"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/* ----------------------------- submission dialog ---------------------------- */

interface DraftItem {
  itemName: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

function itemLineTotalMinor(item: DraftItem): number | null {
  const qty = Number(item.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const price = Number(item.unitPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.round(qty * price * 100 + 1e-9);
}

function initialItems(task: TaskDto): DraftItem[] {
  if (task.items.length === 0) {
    return [{ itemName: "", quantity: "1", unit: "", unitPrice: "" }];
  }
  return task.items.map((it) => ({
    itemName: it.itemName,
    quantity: String(it.expectedQuantity ?? 1),
    unit: it.unit ?? "",
    unitPrice: it.estimatedUnitPriceMinor != null ? (it.estimatedUnitPriceMinor / 100).toFixed(2) : "",
  }));
}

function SubmissionDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateResident();
  const [items, setItems] = useState<DraftItem[]>(() => initialItems(task));
  const [comment, setComment] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalMinor = useMemo(() => {
    let sum = 0;
    let valid = items.length > 0;
    for (const it of items) {
      const line = itemLineTotalMinor(it);
      if (line == null) {
        valid = false;
        continue;
      }
      sum += line;
    }
    return valid ? sum : null;
  }, [items]);

  function patchItem(idx: number, patch: Partial<DraftItem>) {
    setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  async function submit() {
    if (!task || totalMinor == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = items.map((it) => ({
        itemName: it.itemName.trim(),
        quantity: Number(it.quantity),
        unit: it.unit.trim() || undefined,
        unitPrice: it.unitPrice,
      }));
      const form = new FormData();
      form.set("itemsJson", JSON.stringify(payload));
      if (comment.trim()) form.set("comment", comment.trim());
      if (proof) form.set("proof", proof);
      await apiMultipart(`/api/v1/tasks/${task.id}/submission`, form);
      invalidate([RESIDENT_KEYS.tasks, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("task_submitted");
      toast.success("Task submitted — waiting for admin verification", {
        description: `Total claimed ${formatMinor(totalMinor)} · the admin checks it before it enters official expenses.`,
      });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.fields && Object.keys(err.fields).length > 0) {
        setError(Object.values(err.fields)[0] ?? friendlyError(err));
      } else {
        setError(friendlyError(err, "We couldn't submit this task. Please try again."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = totalMinor !== null && totalMinor > 0 && !proofError && !submitting;

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title="Submit purchase"
      description={`"${task.description}" — add what you bought and the prices you paid.`}
      footer={
        <SheetFooterActions onCancel={() => onOpenChange(false)}>
          <GlassButton loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
            Submit for verification
          </GlassButton>
        </SheetFooterActions>
      }
    >
      <div className="space-y-4">
        {/* items repeater */}
        <fieldset className="space-y-3">
          <legend className="mb-1 block text-xs font-medium text-muted-foreground">Items</legend>
          {items.map((item, idx) => {
            const lineTotal = itemLineTotalMinor(item);
            return (
              <div key={idx} className="glass-inset space-y-2.5 rounded-md p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="kpi-num text-xs font-semibold text-muted-foreground">Item {idx + 1}</span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove item ${idx + 1}`}
                      onClick={() => setItems((list) => list.filter((_, i) => i !== idx))}
                      className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  )}
                </div>
                <GlassField label="Name">
                  <GlassInput
                    value={item.itemName}
                    maxLength={120}
                    placeholder="e.g. Basmati rice"
                    onChange={(e) => patchItem(idx, { itemName: e.target.value })}
                  />
                </GlassField>
                <div className="grid grid-cols-2 gap-2.5">
                  <GlassField label="Quantity">
                    <GlassInput
                      inputMode="decimal"
                      value={item.quantity}
                      placeholder="25"
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^\d.]/g, "");
                        patchItem(idx, { quantity: v.slice(0, 9) });
                      }}
                    />
                  </GlassField>
                  <GlassField label="Unit">
                    <GlassInput
                      value={item.unit}
                      maxLength={20}
                      placeholder="kg / litres / pieces"
                      onChange={(e) => patchItem(idx, { unit: e.target.value })}
                    />
                  </GlassField>
                </div>
                <GlassField label="Unit price (₹)">
                  <AmountInput
                    ariaLabel={`Item ${idx + 1} unit price in rupees`}
                    value={item.unitPrice}
                    invalid={item.unitPrice.trim() !== "" && lineTotal == null}
                    onChange={(v) => patchItem(idx, { unitPrice: v })}
                  />
                </GlassField>
                <div className="flex items-baseline justify-between border-t border-border/70 pt-2">
                  <span className="text-xs text-muted-foreground">Line total</span>
                  <span className="kpi-num text-sm font-semibold">
                    {lineTotal != null ? formatMinor(lineTotal) : "—"}
                  </span>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() =>
              setItems((list) => [...list, { itemName: "", quantity: "1", unit: "", unitPrice: "" }])
            }
            className="glass-inset flex h-11 w-full items-center justify-center gap-2 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden />
            Add another item
          </button>
        </fieldset>

        <div className="glass-inset flex items-baseline justify-between rounded-md p-3.5">
          <span className="text-[13px] font-semibold">Total</span>
          <span className="kpi-num text-base font-semibold text-primary">
            {totalMinor != null ? formatMinor(totalMinor) : "—"}
          </span>
        </div>

        <GlassField label="Comment (optional)" hint="Anything the admin should know — price changes, substitutions.">
          <GlassTextarea
            value={comment}
            maxLength={500}
            placeholder="e.g. Prices were higher this week"
            onChange={(e) => setComment(e.target.value)}
          />
        </GlassField>

        <FileProofInput
          file={proof}
          error={proofError}
          onFile={(f) => {
            setProofError(f ? proofProblems(f) : null);
            setProof(f);
          }}
        />

        {error && (
          <p role="alert" className="glass-inset rounded-md px-3 py-2 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </SheetDialog>
  );
}

function GeneralCompletionDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateResident();
  const [comment, setComment] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      if (comment.trim()) form.set("comment", comment.trim());
      if (proof) form.set("proof", proof);
      await apiMultipart(`/api/v1/tasks/${task.id}/submission`, form);
      invalidate([RESIDENT_KEYS.tasks, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("task_submitted");
      toast.success("Completion submitted — waiting for admin verification", {
        description: "Normal Tasks never create a mess expense or ledger entry.",
      });
      onOpenChange(false);
    } catch (err) {
      setError(friendlyError(err, "We couldn't submit this completion. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title="Submit completion"
      description={`"${task.description}" — tell the admin the work is done. No purchase or expense is created.`}
      footer={
        <SheetFooterActions onCancel={() => onOpenChange(false)}>
          <GlassButton loading={submitting} disabled={Boolean(proofError) || submitting} onClick={() => void submit()}>
            Submit completion
          </GlassButton>
        </SheetFooterActions>
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-3.5 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Normal Task · non-financial</p>
          <p className="mt-1 leading-relaxed">
            This completion goes to the Admin for verification. It cannot create an Expense or change the ledger.
          </p>
        </div>
        <GlassField label="Completion note (optional)" hint="Briefly describe what you completed.">
          <GlassTextarea
            value={comment}
            maxLength={500}
            placeholder="e.g. Filled and placed the water container in the kitchen"
            onChange={(e) => setComment(e.target.value)}
          />
        </GlassField>
        <FileProofInput
          file={proof}
          error={proofError}
          onFile={(file) => {
            setProofError(file ? proofProblems(file) : null);
            setProof(file);
          }}
        />
        {error && (
          <p role="alert" className="glass-inset rounded-md px-3 py-2 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </SheetDialog>
  );
}

/* ---------------------------- task progress stepper --------------------------- */

function TaskProgressStepper({ status }: { status: string }) {
  const steps = [
    { key: "ASSIGNED", label: "Assigned" },
    { key: "ACCEPTED", label: "Accepted" },
    { key: "IN_PROGRESS", label: "In Progress" },
    {
      key: "DONE",
      label: status === "SUBMITTED" ? "Submitted" : status === "APPROVED" ? "Approved" : "Completed",
    },
  ];

  const isRejected = status === "REJECTED" || status === "REJECTED_BY_ADMIN";

  const getStepState = (stepIndex: number): "complete" | "active" | "rejected" | "upcoming" => {
    if (isRejected) {
      if (stepIndex === 0) return "complete";
      if (stepIndex === 1) return "rejected";
      return "upcoming";
    }
    const statusOrder: Record<string, number> = {
      ASSIGNED: 0,
      ACCEPTED: 1,
      IN_PROGRESS: 2,
      SUBMITTED: 3,
      APPROVED: 4,
    };
    const current = statusOrder[status] ?? 0;
    if (stepIndex < current) return "complete";
    if (stepIndex === current) return "active";
    return "upcoming";
  };

  return (
    <div className="glass-inset rounded-2xl p-3.5 border border-border/40">
      <div className="flex items-center justify-between relative px-2">
        {/* Connecting progress line */}
        <div className="absolute left-6 right-6 top-3.5 h-0.5 bg-border/40 -z-0" />

        {steps.map((step, idx) => {
          const state = getStepState(idx);
          return (
            <div key={step.key} className="flex flex-col items-center relative z-10">
              <div
                className={cn(
                  "size-7 rounded-full flex items-center justify-center text-xs font-bold transition-all border",
                  state === "complete"
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : state === "active"
                      ? "bg-primary/20 text-primary border-primary ring-2 ring-primary/40"
                      : state === "rejected"
                        ? "bg-danger/20 text-danger border-danger/40 ring-2 ring-danger/30"
                        : "bg-muted/80 text-muted-foreground border-border/50"
                )}
              >
                {state === "complete" ? (
                  <CheckCircle2 className="size-4" />
                ) : state === "rejected" && idx === 1 ? (
                  <XCircle className="size-4" />
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  "text-[11px] mt-1.5 font-medium whitespace-nowrap",
                  state === "active"
                    ? "text-primary font-bold"
                    : state === "complete"
                      ? "text-foreground font-semibold"
                      : state === "rejected" && idx === 1
                        ? "text-danger font-semibold"
                        : "text-muted-foreground"
                )}
              >
                {isRejected && idx === 1 ? "Declined" : step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------- task detail dialog --------------------------- */

function KeyValueRow({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/15 last:border-0 text-xs">
      <span className="text-muted-foreground font-medium shrink-0">{label}</span>
      <span className="font-semibold text-foreground text-right truncate">{value}</span>
    </div>
  );
}

function TaskDetailDialog({
  task,
  onClose,
  tz,
  onAccept,
  onReject,
  onStart,
  onSubmitPurchase,
  busy,
}: {
  task: TaskDto | null;
  onClose: () => void;
  tz: string;
  onAccept: (task: TaskDto) => void;
  onReject: (task: TaskDto) => void;
  onStart: (task: TaskDto) => void;
  onSubmitPurchase: (task: TaskDto) => void;
  busy: boolean;
}) {
  // Calculate items total estimated minor if available (hook called unconditionally)
  const itemsEstimatedSumMinor = useMemo(() => {
    if (!task?.items) return null;
    let sum = 0;
    let hasValues = false;
    for (const it of task.items) {
      if (it.estimatedUnitPriceMinor != null && it.expectedQuantity != null) {
        sum += it.estimatedUnitPriceMinor * it.expectedQuantity;
        hasValues = true;
      }
    }
    return hasValues ? sum : null;
  }, [task?.items]);

  if (!task) return null;
  const isMarketTask = task.taskType === "MARKET_PURCHASE";
  const TaskIcon = isMarketTask ? ShoppingCart : ClipboardList;
  const orbColor = taskOrbColor(task.status);
  const sub = task.submission;
  const todayKey = todayKeyInTz(tz);
  const isOverdue =
    Boolean(task.dueDate) &&
    task.status !== "APPROVED" &&
    task.status !== "REJECTED" &&
    task.status !== "REJECTED_BY_ADMIN" &&
    task.status !== "CANCELLED" &&
    task.dueDate! < todayKey;
  const isDueToday = Boolean(task.dueDate) && task.dueDate === todayKey;

  return (
    <Dialog open={Boolean(task)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-panel border-border/60 max-w-lg sm:max-w-xl rounded-3xl p-0 overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border/20 px-5 pt-5 pb-4 sm:px-6">
          <div className="flex items-start gap-3 min-w-0">
            <MealOrb icon={<TaskIcon />} colorToken={orbColor} size="md" className="shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={task.status} />
                <TaskTypeChip taskType={task.taskType} />
                {task.items.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-pill bg-muted/60 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    <Package className="size-3" /> {task.items.length} item{task.items.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <DialogTitle className="text-base sm:text-lg font-bold text-foreground leading-snug">
                {task.description}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Assigned on {formatDateTimeInTz(task.createdAt, tz)}
              </DialogDescription>
            </div>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="space-y-4 px-5 py-4 sm:px-6 max-h-[66vh] overflow-y-auto no-scrollbar">
          {/* Visual lifecycle stepper */}
          {task.status !== "CANCELLED" && <TaskProgressStepper status={task.status} />}

          {/* Due date deadline hero card */}
          {task.dueDate && (
            <div
              className={cn(
                "glass-inset flex items-center justify-between rounded-2xl p-3.5 border transition-all",
                isOverdue
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : isDueToday
                    ? "border-warning/40 bg-warning/10 text-warning"
                    : "border-primary/25 bg-primary/5 text-foreground"
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-xl",
                    isOverdue
                      ? "bg-danger/20 text-danger"
                      : isDueToday
                        ? "bg-warning/20 text-warning"
                        : "bg-primary/15 text-primary"
                  )}
                >
                  <CalendarClock className="size-4.5" />
                </span>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Target Deadline
                  </p>
                  <p className="text-xs sm:text-sm font-bold">
                    Due by {task.dueDate}
                  </p>
                </div>
              </div>
              <div>
                {isOverdue ? (
                  <span className="rounded-pill bg-danger/20 border border-danger/35 px-2.5 py-1 text-[10px] font-extrabold text-danger tracking-wide">
                    PAST DUE
                  </span>
                ) : isDueToday ? (
                  <span className="rounded-pill bg-warning/20 border border-warning/35 px-2.5 py-1 text-[10px] font-extrabold text-warning tracking-wide">
                    DUE TODAY
                  </span>
                ) : (
                  <span className="rounded-pill bg-primary/15 border border-primary/30 px-2.5 py-1 text-[10px] font-semibold text-primary">
                    Upcoming
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Financial summary: Budget vs Claimed hero */}
          {(task.estimatedAmountMinor != null || sub?.claimedTotalMinor != null) && (
            <div className="glass-inset rounded-2xl p-4 border border-border/40">
              {sub?.claimedTotalMinor != null && task.estimatedAmountMinor != null ? (
                <div className="grid grid-cols-2 gap-3 divide-x divide-border/20">
                  <div className="text-center pr-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Estimated Budget
                    </p>
                    <Money
                      minor={task.estimatedAmountMinor}
                      className="text-lg sm:text-xl font-bold text-foreground mt-1"
                    />
                  </div>
                  <div className="text-center pl-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                      Actual Claimed
                    </p>
                    <Money
                      minor={sub.claimedTotalMinor}
                      className="text-lg sm:text-xl font-extrabold text-foreground mt-1"
                    />
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                    {sub?.claimedTotalMinor != null ? "Total Claimed Expense" : "Estimated Budget"}
                  </p>
                  <Money
                    minor={sub?.claimedTotalMinor ?? task.estimatedAmountMinor ?? 0}
                    className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {sub?.claimedTotalMinor != null
                      ? "Submitted by you for mess expense reimbursement"
                      : "Allocated by mess admin for this task"}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Status contextual guide notice */}
          {task.status === "ASSIGNED" && (
            <div className="rounded-2xl border border-primary/25 bg-primary/5 p-3.5 text-xs text-foreground leading-relaxed flex items-start gap-2.5">
              <ListChecks className="size-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-primary">Task Pending Your Response</p>
                <p className="text-muted-foreground mt-0.5">
                  Review the details below. Click <strong>Accept Task</strong> to take responsibility or <strong>Reject Task</strong> if you cannot complete it.
                </p>
              </div>
            </div>
          )}

          {task.status === "ACCEPTED" && (
            <div className="rounded-2xl border border-primary/25 bg-primary/5 p-3.5 text-xs text-foreground leading-relaxed flex items-start gap-2.5">
              {isMarketTask ? (
                <ShoppingCart className="size-4 text-primary shrink-0 mt-0.5" />
              ) : (
                <ClipboardList className="size-4 text-primary shrink-0 mt-0.5" />
              )}
              <div>
                <p className="font-semibold text-primary">Ready to Execute</p>
                <p className="text-muted-foreground mt-0.5">
                  {isMarketTask ? (
                    <>You accepted this Market Task. Click <strong>Start Task</strong> when you begin shopping; submit the purchase after the work is done.</>
                  ) : (
                    <>You accepted this Normal Task. Click <strong>Start Task</strong> when you begin, then submit completion for Admin verification.</>
                  )}
                </p>
              </div>
            </div>
          )}

          {task.status === "SUBMITTED" && (
            <div className="rounded-2xl border border-warning/30 bg-warning/10 p-3.5 text-xs text-warning leading-relaxed flex items-start gap-2.5">
              <Hourglass className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Awaiting Admin Verification</p>
                <p className="text-muted-foreground mt-0.5">
                  Your purchase details and receipt have been submitted. The admin will verify and post it directly to official expenses.
                </p>
              </div>
            </div>
          )}

          {task.status === "APPROVED" && (
            <div className="rounded-2xl border border-success/30 bg-success/10 p-3.5 text-xs text-success leading-relaxed flex items-start gap-2.5">
              <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Verified & Approved</p>
                <p className="text-muted-foreground mt-0.5">
                  The admin verified and approved this submission. The amount is recorded as an expense.
                </p>
              </div>
            </div>
          )}

          {(task.status === "REJECTED" || task.status === "REJECTED_BY_ADMIN" || task.status === "CANCELLED") && (
            <div className="rounded-2xl border border-danger/30 bg-danger/10 p-3.5 text-xs text-danger leading-relaxed flex items-start gap-2.5">
              <TriangleAlert className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  {task.status === "REJECTED"
                    ? "You Declined This Task"
                    : task.status === "CANCELLED"
                      ? "Task Cancelled by Admin"
                      : "Submission Rejected by Admin"}
                </p>
                <p className="mt-0.5 text-foreground/80">
                  {task.status === "REJECTED"
                    ? task.rejectionReason ?? "No reason provided."
                    : task.adminReviewReason ?? (task.status === "CANCELLED" ? "No cancellation reason provided." : "No review reason provided.")}
                </p>
              </div>
            </div>
          )}

          {/* Admin instructions / Notes */}
          {task.notes && (
            <div className="glass-inset rounded-2xl p-4 border border-border/40 space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <FileText className="size-3.5 text-primary" /> Manager Instructions
              </p>
              <p className="text-xs sm:text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                {task.notes}
              </p>
            </div>
          )}

          {/* Items requested to purchase */}
          {task.items.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Package className="size-3.5 text-primary" /> Requested Items ({task.items.length})
                </p>
                {itemsEstimatedSumMinor != null && (
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Est. Total: <span className="font-bold text-foreground">{formatMinor(itemsEstimatedSumMinor)}</span>
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                {task.items.map((item) => (
                  <div
                    key={item.id}
                    className="glass-inset flex items-center justify-between rounded-xl px-3.5 py-2.5 text-xs border border-border/40"
                  >
                    <div className="min-w-0 pr-2">
                      <span className="font-semibold text-foreground block truncate">{item.itemName}</span>
                      {item.expectedQuantity && (
                        <span className="text-[11px] text-muted-foreground">
                          Qty: {item.expectedQuantity} {item.unit ?? ""}
                        </span>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {item.estimatedUnitPriceMinor != null ? (
                        <div>
                          <span className="font-semibold text-foreground block">
                            {formatMinor(item.estimatedUnitPriceMinor)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">per unit</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-[11px]">—</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Submission details and proof */}
          {sub && (
            <div className="space-y-3 border-t border-border/20 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                {isMarketTask ? (
                  <ShoppingCart className="size-3.5 text-primary" />
                ) : (
                  <ClipboardList className="size-3.5 text-primary" />
                )}
                {isMarketTask ? "Purchase Submission Details" : "Completion Details"}
              </p>
              <div className="glass-inset rounded-2xl p-3.5 border border-border/40 space-y-1">
                {isMarketTask && (
                  <KeyValueRow
                    label="Claimed Total"
                    value={<Money minor={sub.claimedTotalMinor} className="font-bold text-foreground text-sm" />}
                  />
                )}
                <KeyValueRow
                  label="Submitted On"
                  value={formatDateTimeInTz(sub.submittedAt, tz)}
                />
                {sub.comment && (
                  <div className="pt-1.5 text-xs">
                    <span className="text-muted-foreground block font-medium mb-0.5">
                      {isMarketTask ? "Your comment:" : "Completion note:"}
                    </span>
                    <p className="text-foreground leading-relaxed">{sub.comment}</p>
                  </div>
                )}
              </div>

              {sub.proofFileId && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                    <Paperclip className="size-3.5 text-primary" /> {isMarketTask ? "Attached Receipt / Bill Proof" : "Completion Proof"}
                  </p>
                  <ProofImage fileId={sub.proofFileId} alt={`Proof for ${task.description}`} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/20 px-5 py-3.5 sm:px-6 bg-background/50 backdrop-blur-md">
          <GlassButton onClick={onClose} variant="ghost" className="px-4 text-xs">
            Close
          </GlassButton>

          <div className="flex items-center gap-2">
            {task.status === "ASSIGNED" && (
              <>
                <GlassButton
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    onClose();
                    onReject(task);
                  }}
                >
                  Reject Task
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="primary"
                  loading={busy}
                  icon={<CheckCircle2 className="size-3.5" />}
                  onClick={() => {
                    onClose();
                    onAccept(task);
                  }}
                >
                  Accept Task
                </GlassButton>
              </>
            )}

            {task.status === "ACCEPTED" && (
              <GlassButton
                size="sm"
                variant="primary"
                icon={isMarketTask ? <ShoppingCart className="size-3.5" /> : <ClipboardList className="size-3.5" />}
                loading={busy}
                onClick={() => {
                  onClose();
                  onStart(task);
                }}
              >
                Start Task
              </GlassButton>
            )}

            {task.status === "IN_PROGRESS" && (
              <GlassButton
                size="sm"
                variant="primary"
                icon={isMarketTask ? <ShoppingCart className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                onClick={() => {
                  onClose();
                  onSubmitPurchase(task);
                }}
              >
                {isMarketTask ? "Submit Purchase" : "Submit Completion"}
              </GlassButton>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- the view --------------------------------- */

export default function ResidentTasks() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const invalidate = useInvalidateResident();

  const currentMonthKey = todayKeyInTz(tz).slice(0, 7);
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const monthKey = monthParam ?? currentMonthKey;
  const [status, setStatus] = useState<string>("ASSIGNED");
  const [search, setSearch] = useState("");

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTask, setRejectTask] = useState<TaskDto | null>(null);
  const [submitTask, setSubmitTask] = useState<TaskDto | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDto | null>(null);

  const tasksQuery = useApiQuery<TaskDto[]>("/api/v1/tasks");
  const allTasks = tasksQuery.data ?? [];

  /** Tasks filtered by the selected month */
  const monthTasks = useMemo(() => {
    const todayKey = todayKeyInTz(tz);
    return allTasks.filter((t) => {
      const taskMonth = t.dueDate
        ? t.dueDate.slice(0, 7)
        : dateKeyInTz(new Date(t.createdAt), tz).slice(0, 7);

      if (taskMonth === monthKey) return true;

      // In the current month, also surface any active tasks that are overdue from earlier months
      if (monthKey === currentMonthKey) {
        const finished =
          t.status === "APPROVED" ||
          t.status === "REJECTED" ||
          t.status === "REJECTED_BY_ADMIN" ||
          t.status === "CANCELLED";
        if (!finished && t.dueDate && t.dueDate < todayKey) return true;
      }

      return false;
    });
  }, [allTasks, monthKey, currentMonthKey, tz]);

  /** Status overview KPIs (matching Admin Tasks 3-column layout) for the active month */
  const stats = useMemo(() => {
    const todayKey = todayKeyInTz(tz);
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const t of monthTasks) {
      if (t.status === "ASSIGNED" || t.status === "ACCEPTED" || t.status === "IN_PROGRESS") open += 1;
      else if (t.status === "APPROVED") done += 1;
      const finished =
        t.status === "APPROVED" ||
        t.status === "REJECTED" ||
        t.status === "REJECTED_BY_ADMIN" ||
        t.status === "CANCELLED";
      if (!finished && t.dueDate && t.dueDate < todayKey) overdue += 1;
    }
    return { open, done, overdue };
  }, [monthTasks, tz]);

  /** Counts per status for the filter pills for the active month */
  const countsByStatus = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of monthTasks) {
      map[t.status] = (map[t.status] ?? 0) + 1;
    }
    return map;
  }, [monthTasks]);

  const chips = useMemo(
    () =>
      STATUS_CHIPS.map((c) => ({
        value: c.value,
        label: c.label,
        count: c.value === "ALL" ? undefined : countsByStatus[c.value],
      })),
    [countsByStatus]
  );

  /** Filter and sort tasks by month, status, and search query */
  const filteredTasks = useMemo(() => {
    let list = monthTasks;

    // Filter by status
    if (status !== "ALL") {
      list = list.filter((t) => t.status === status);
    }

    // Filter by search query
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.description.toLowerCase().includes(q) ||
          (t.notes ?? "").toLowerCase().includes(q) ||
          t.items.some((i) => i.itemName.toLowerCase().includes(q))
      );
    }

    // Sort tasks within the month:
    // 1. Open/active tasks first, sorted by due date ascending (soonest deadline / overdue first)
    // 2. Waiting for review (SUBMITTED) next
    // 3. Completed/rejected tasks last, sorted newest first
    return [...list].sort((a, b) => {
      const getRank = (st: string) => {
        if (st === "ASSIGNED" || st === "ACCEPTED" || st === "IN_PROGRESS") return 0;
        if (st === "SUBMITTED") return 1;
        if (st === "APPROVED") return 2;
        return 3;
      };

      const rankA = getRank(a.status);
      const rankB = getRank(b.status);
      if (rankA !== rankB) return rankA - rankB;

      // If both are active, sort by due date ascending (soonest due first)
      if (rankA === 0) {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }

      // For completed/closed, sort newest first
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [monthTasks, status, search]);

  async function transition(
    task: TaskDto,
    action: "accept" | "start" | "reject",
    reason?: string
  ): Promise<void> {
    setBusyId(task.id);
    try {
      await apiJson(`/api/v1/tasks/${task.id}/${action}`, "POST", reason ? { reason } : {});
      invalidate([RESIDENT_KEYS.tasks, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("task_updated");
      if (action === "accept") toast.success(`Task accepted — "${task.description}"`);
      if (action === "start")
        toast.success(
          task.taskType === "MARKET_PURCHASE"
            ? "Market Task started — submit the purchase when shopping is complete."
            : "Normal Task started — submit completion when the work is done."
        );
      if (action === "reject") toast.success("Task rejected — the admin has been notified.");
      if (action === "reject") setRejectTask(null);
    } catch (err) {
      if (err instanceof ApiClientError) {
        toast.error(err.message);
      } else {
        toast.error(friendlyError(err));
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {tasksQuery.isPending ? (
        <div className="space-y-4">
          <ListSkeleton rows={4} />
        </div>
      ) : tasksQuery.isError ? (
        <ErrorState
          code={tasksQuery.error?.code}
          message={tasksQuery.error?.message}
          onRetry={() => void tasksQuery.refetch()}
        />
      ) : (
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

          {/* KPIs — 3-column status overview (matching admin tasks, meals & payments) */}
          <StaggerItem>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <KpiCard
                label="Open"
                value={String(stats.open)}
                sub="Assigned"
                icon={<ListChecks />}
                glow="primary"
                tone="primary"
                index={0}
              />
              <KpiCard
                label="Done"
                value={String(stats.done)}
                sub="Approved"
                icon={<CheckCircle2 />}
                glow="success"
                tone="success"
                index={1}
              />
              <KpiCard
                label="Overdue"
                value={String(stats.overdue)}
                sub="Past due"
                icon={<TriangleAlert />}
                glow="danger"
                tone="danger"
                index={2}
              />
            </div>
          </StaggerItem>

          {/* ONE section card — matches admin tasks & meals-page anatomy:
              ClipboardList icon header, search + filter pills INSIDE, method-orb rows below. */}
          <StaggerItem>
            <GlassCard className="p-4 border border-border/40">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <ClipboardList className="size-5" aria-hidden />
                  </span>
                  <h3 className="font-semibold text-base">My tasks</h3>
                </div>
              </div>

              <div className="mb-3 space-y-3">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Search tasks by description or item…"
                />
                <DropletFilterChips
                  chips={chips}
                  value={status}
                  onChange={setStatus}
                  layoutId="resident-tasks-chips"
                  aria-label="Filter tasks"
                />
              </div>

              {filteredTasks.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title={status === "ALL" ? `No tasks in ${monthLongName(monthKey)}` : `No ${status.toLowerCase()} tasks`}
                  description={
                    search
                      ? "Try a different search query or filter."
                      : status === "ALL"
                        ? `You have no tasks assigned for ${monthLongName(monthKey)} ${monthKey.slice(0, 4)}.`
                        : "Try another filter to see your other tasks."
                  }
                />
              ) : (
                <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  <AnimatePresence initial={false}>
                    {filteredTasks.map((task, i) => {
                      const orbColor = taskOrbColor(task.status);
                      const TaskIcon = task.taskType === "MARKET_PURCHASE" ? ShoppingCart : ClipboardList;
                      const busy = busyId === task.id;

                      return (
                        <motion.div
                          key={task.id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.2, ease: "easeOut", delay: Math.min(i * 0.04, 0.2) }}
                        >
                          <GlassCard className="overflow-hidden rounded-2xl border border-border/40">
                            <div
                              className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                              onClick={() => setSelectedTask(task)}
                            >
                              {/* Top row: Identity & Details (Left), Amount (Right) */}
                              <div className="flex h-10 items-center justify-between gap-3">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <MealOrb icon={<TaskIcon />} colorToken={orbColor} size="sm" />
                                  <div className="min-w-0">
                                    <h4
                                      className="truncate text-sm font-semibold text-foreground tracking-tight"
                                      title={task.description}
                                    >
                                      {task.description}
                                    </h4>
                                    <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1.5 truncate">
                                      {task.items.length > 0 ? (
                                        <span>
                                          {task.items.length} item{task.items.length === 1 ? "" : "s"}
                                        </span>
                                      ) : task.notes ? (
                                        <span className="truncate">{task.notes}</span>
                                      ) : (
                                        <span>{TASK_TYPE_LABELS[task.taskType] ?? task.taskType}</span>
                                      )}
                                    </p>
                                  </div>
                                </div>

                                <div className="text-right shrink-0">
                                  {task.dueDate ? (
                                    <div className="flex flex-col items-end">
                                      <span
                                        className={cn(
                                          "kpi-num inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold border",
                                          task.dueDate < todayKeyInTz(tz) &&
                                            task.status !== "APPROVED" &&
                                            task.status !== "REJECTED"
                                            ? "bg-danger/15 text-danger border-danger/30"
                                            : "bg-primary/10 text-primary border-primary/25"
                                        )}
                                      >
                                        <Clock className="size-3 shrink-0" aria-hidden />
                                        <span>Due {task.dueDate}</span>
                                      </span>
                                      {task.submission?.claimedTotalMinor ? (
                                        <span className="kpi-num text-[11px] font-medium text-muted-foreground mt-0.5 block">
                                          Claimed{" "}
                                          <Money
                                            minor={task.submission.claimedTotalMinor}
                                            className="font-bold text-foreground"
                                          />
                                        </span>
                                      ) : task.estimatedAmountMinor != null ? (
                                        <span className="kpi-num text-[11px] font-medium text-muted-foreground mt-0.5 block">
                                          Est.{" "}
                                          <Money
                                            minor={task.estimatedAmountMinor}
                                            className="font-semibold text-foreground"
                                          />
                                        </span>
                                      ) : (
                                        <span className="kpi-num text-[10px] font-medium text-muted-foreground block mt-0.5">
                                          due date
                                        </span>
                                      )}
                                    </div>
                                  ) : task.submission?.claimedTotalMinor ? (
                                    <div>
                                      <Money
                                        minor={task.submission.claimedTotalMinor}
                                        className="text-base sm:text-lg font-bold text-foreground block leading-tight"
                                      />
                                      <span className="kpi-num text-[10px] sm:text-[11px] font-medium text-muted-foreground block mt-0.5">
                                        claimed
                                      </span>
                                    </div>
                                  ) : task.estimatedAmountMinor != null ? (
                                    <div>
                                      <Money
                                        minor={task.estimatedAmountMinor}
                                        className="text-base sm:text-lg font-bold text-foreground block leading-tight"
                                      />
                                      <span className="kpi-num text-[10px] sm:text-[11px] font-medium text-muted-foreground block mt-0.5">
                                        estimated
                                      </span>
                                    </div>
                                  ) : (
                                    <div>
                                      <span className="text-xs sm:text-sm font-medium text-muted-foreground block leading-tight">
                                        {task.createdAt.slice(0, 10)}
                                      </span>
                                      <span className="kpi-num text-[10px] sm:text-[11px] font-medium text-muted-foreground block mt-0.5">
                                        assigned
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Bottom row: Badges on left (Status, Type), Action buttons on right (directly under due date) */}
                              <div className="mt-2.5 flex min-h-7 flex-wrap items-center justify-between gap-2 border-t border-border/15 pt-2">
                                <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                                  <StatusBadge status={task.status} />
                                  <TaskTypeChip taskType={task.taskType} />
                                  {task.items.length > 0 && (
                                    <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                                      · {task.items.length} item{task.items.length === 1 ? "" : "s"}
                                    </span>
                                  )}
                                  {task.submission?.proofFileId && (
                                    <span className="inline-flex items-center gap-0.5 text-[11px] text-primary font-medium shrink-0">
                                      <Paperclip className="size-3" aria-hidden /> Proof
                                    </span>
                                  )}
                                </div>

                                {/* Right action buttons: only operational buttons (Accept, Reject, Start, Submit purchase) — placed directly below due date */}
                                <div className="flex shrink-0 items-center gap-1.5 ml-auto" onClick={(e) => e.stopPropagation()}>
                                  {task.status === "ASSIGNED" && (
                                    <>
                                      <GlassButton
                                        size="sm"
                                        variant="primary"
                                        className="h-7 px-3 text-xs font-semibold"
                                        loading={busy}
                                        onClick={() => void transition(task, "accept")}
                                      >
                                        Accept
                                      </GlassButton>
                                      <GlassButton
                                        size="sm"
                                        variant="secondary"
                                        className="h-7 px-3 text-xs font-semibold"
                                        disabled={busy}
                                        onClick={() => setRejectTask(task)}
                                      >
                                        Reject
                                      </GlassButton>
                                    </>
                                  )}

                                  {task.status === "ACCEPTED" && (
                                    <GlassButton
                                      size="sm"
                                      variant="primary"
                                      className="h-7 px-3 text-xs"
                                      loading={busy}
                                      icon={task.taskType === "MARKET_PURCHASE" ? <ShoppingCart className="size-3" /> : <ClipboardList className="size-3" />}
                                      onClick={() => void transition(task, "start")}
                                    >
                                      Start
                                    </GlassButton>
                                  )}

                                  {task.status === "IN_PROGRESS" && (
                                    <GlassButton
                                      size="sm"
                                      variant="primary"
                                      className="h-7 px-3 text-xs"
                                      icon={task.taskType === "MARKET_PURCHASE" ? <ShoppingCart className="size-3" /> : <CheckCircle2 className="size-3" />}
                                      onClick={() => setSubmitTask(task)}
                                    >
                                      {task.taskType === "MARKET_PURCHASE" ? "Submit purchase" : "Submit completion"}
                                    </GlassButton>
                                  )}
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
        </StaggerGroup>
      )}

      {/* Task detail dialog */}
      <TaskDetailDialog
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        tz={tz}
        onAccept={(t) => void transition(t, "accept")}
        onReject={(t) => setRejectTask(t)}
        onStart={(t) => void transition(t, "start")}
        onSubmitPurchase={(t) => setSubmitTask(t)}
        busy={Boolean(selectedTask && busyId === selectedTask.id)}
      />

      {/* Reject reason dialog (required) */}
      <ConfirmDialog
        open={rejectTask != null}
        onOpenChange={(open) => {
          if (!open) setRejectTask(null);
        }}
        title="Reject this task?"
        description={
          rejectTask
            ? `"${rejectTask.description}" will go back to the admin. Your reason is kept for the record.`
            : undefined
        }
        confirmLabel="Reject task"
        tone="destructive"
        requireReason
        reasonPlaceholder="Why can't you take this on? (required)"
        loading={busyId === rejectTask?.id}
        onConfirm={(reason) => {
          if (rejectTask && reason) void transition(rejectTask, "reject", reason);
        }}
      />

      {/* Task submission dialog — purchase details only exist for Market Tasks. */}
      {submitTask ? (
        submitTask.taskType === "GENERAL" ? (
          <GeneralCompletionDialog
            key={submitTask.id}
            task={submitTask}
            open
            onOpenChange={(open) => {
              if (!open) setSubmitTask(null);
            }}
          />
        ) : (
          <SubmissionDialog
            key={submitTask.id}
            task={submitTask}
            open
            onOpenChange={(open) => {
              if (!open) setSubmitTask(null);
            }}
          />
        )
      ) : null}
    </div>
  );
}
