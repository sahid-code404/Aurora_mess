import { cn } from "@/lib/utils";

/**
 * StatusBadge — maps the domain status vocabulary to tinted glass badges.
 * ALWAYS text + optional dot (never color-only). Tint families:
 *   emerald → ON / APPROVED / ACTIVE / PAID …
 *   amber   → ADMIN OVERRIDE / PENDING approval-ish / GRACE / CHANGES REQUESTED
 *   graphite→ OFF / PENDING / LOCKED / ON LEAVE / NOT AVAILABLE
 *   red     → REJECTED / VOIDED / OVERDUE / RESTRICTED / FAILED
 *   frost   → OPEN / BILLED / CLOSING (billing lifecycle)
 */

type Tone = "success" | "warning" | "danger" | "neutral" | "frost";

const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-success/14 text-success border-success/32 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  warning: "bg-warning/16 text-warning border-warning/36 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  danger: "bg-danger/14 text-danger border-danger/32 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
  neutral: "bg-muted/70 text-muted-foreground border-border shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]",
  frost: "bg-primary/12 text-primary border-primary/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
};

const STATUS_TONES: Record<string, Tone> = {
  // Meal / participation
  ON: "success",
  OFF: "neutral",
  ON_LEAVE: "neutral",
  NOT_AVAILABLE: "neutral",
  LOCKED: "neutral",
  PENDING: "neutral",
  ADMIN_OVERRIDE: "warning",
  // People / lifecycle
  ACTIVE: "success",
  INACTIVE: "neutral",
  PENDING_APPROVAL: "warning",
  CHANGES_REQUESTED: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  PENDING_DELETION: "danger",
  // Money
  PAID: "success",
  SETTLED: "success",
  APPROVE: "success",
  DUE: "warning",
  GRACE: "warning",
  RESTRICTED: "danger",
  OVERDUE: "danger",
  VOIDED: "danger",
  REFUNDED: "frost",
  // Tasks
  ACCEPTED: "success",
  ASSIGNED: "frost",
  IN_PROGRESS: "frost",
  SUBMITTED: "warning",
  REJECTED_BY_ADMIN: "danger",
  CANCELLED: "neutral",
  COMPLETED: "success",
  // Billing lifecycle
  OPEN: "frost",
  CLOSING: "warning",
  BILLED: "frost",
  REOPENED: "warning",
};

const STATUS_LABELS: Record<string, string> = {
  ON: "On",
  OFF: "Off",
  ON_LEAVE: "Leave",
  NOT_AVAILABLE: "Not available",
  LOCKED: "Locked",
  PENDING: "Pending",
  ADMIN_OVERRIDE: "Admin override",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  PENDING_APPROVAL: "Pending approval",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PENDING_DELETION: "Deletion pending",
  PAID: "Paid",
  SETTLED: "Settled",
  DUE: "Due",
  GRACE: "Grace",
  RESTRICTED: "Restricted",
  OVERDUE: "Overdue",
  VOIDED: "Voided",
  REFUNDED: "Refunded",
  ACCEPTED: "Accepted",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  REJECTED_BY_ADMIN: "Rejected by admin",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
  OPEN: "Open",
  CLOSING: "Closing",
  BILLED: "Billed",
  REOPENED: "Reopened",
};

function normalize(status: string): string {
  return status.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function StatusBadge({
  status,
  label,
  dot = true,
  icon: Icon,
  className,
}: {
  status: string;
  /** Override the humanized label (default derived from the status code). */
  label?: string;
  dot?: boolean;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  className?: string;
}) {
  const key = normalize(status);
  const tone = STATUS_TONES[key] ?? "neutral";
  const text = label ?? STATUS_LABELS[key] ?? status;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 sm:gap-1.5 rounded-pill border px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold whitespace-nowrap",
        TONE_CLASSES[tone],
        className
      )}
    >
      {Icon ? (
        <Icon className="size-3 shrink-0" aria-hidden />
      ) : dot ? (
        <span
          className="pulse-dot size-1.5 shrink-0 rounded-full bg-current opacity-90"
          aria-hidden
        />
      ) : null}
      {text}
    </span>
  );
}

export default StatusBadge;
