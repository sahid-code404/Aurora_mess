/**
 * ACTIVITY COPY — maps audit events to human-readable activity feed lines
 * (spec §206: plain-language, no domain codes leaked to residents).
 * Unknown actions fall back to a prettified "action · entity" line.
 */
import { formatMinor } from "@/lib/money";

export type AuditEventLike = {
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  beforeSummary?: string | null;
  afterSummary?: string | null;
  metadataJson?: string | null;
  occurredAt: Date;
};

function money(minor: unknown): string {
  return typeof minor === "number" ? formatMinor(minor) : "";
}

function ref(m: Record<string, unknown>): string {
  const display = m.displayNumber ?? m.billNumber;
  return typeof display === "string" ? ` (${display})` : "";
}

function reasonSuffix(e: AuditEventLike): string {
  return e.reason ? ` — ${e.reason}` : "";
}

/** Build the human copy for one audit event. */
export function describeAuditEvent(e: AuditEventLike): string {
  let m: Record<string, unknown> = {};
  if (e.metadataJson) {
    try {
      const parsed = JSON.parse(e.metadataJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        m = parsed as Record<string, unknown>;
      }
    } catch {
      m = {};
    }
  }
  const amount = money(m.amountMinor);
  switch (e.action) {
    case "PAYMENT_SUBMITTED":
    case "PAYMENT_APPROVED":
    case "PAYMENT_REJECTED":
    case "PAYMENT_VOIDED": {
      const verb =
        e.action === "PAYMENT_SUBMITTED"
          ? "submitted"
          : e.action === "PAYMENT_APPROVED"
            ? "approved"
            : e.action === "PAYMENT_REJECTED"
              ? "rejected"
              : "voided";
      return `Payment${ref(m)} of ${amount || "an amount"} ${verb}${reasonSuffix(e)}`.replace("  ", " ");
    }
    case "REFUND_ISSUED": {
      const mode = m.mode === "CARRY_FORWARD" ? "excess credit resolved" : "refund issued";
      return `${mode.charAt(0).toUpperCase()}${mode.slice(1)} — ${amount || "an amount"}${refSuffix(m)}${reasonSuffix(e)}`;
    }
    case "EXPENSE_CREATED":
    case "EXPENSE_APPROVED":
    case "EXPENSE_REJECTED":
    case "EXPENSE_VOIDED": {
      const verb =
        e.action === "EXPENSE_CREATED"
          ? "recorded"
          : e.action === "EXPENSE_APPROVED"
            ? "approved"
            : e.action === "EXPENSE_REJECTED"
              ? "rejected"
              : "voided";
      return `Expense${ref(m)} of ${amount || "an amount"} ${verb}${reasonSuffix(e)}`;
    }
    case "FORMULA_VERSION_CREATED":
      return `Meal charge formula updated${m.version ? ` to v${m.version}` : ""}${reasonSuffix(e)}`;
    case "BILLING_GENERATED": {
      const bills = typeof m.billCount === "number" ? `${m.billCount} bill${m.billCount === 1 ? "" : "s"}` : "bills";
      return `Billing generated — ${bills}${amount ? ` totalling ${amount}` : ""}`;
    }
    case "BILLING_REOPENED":
      return `A billed period was reopened${reasonSuffix(e)}`;
    case "BILL_ADJUSTED":
      return `Bill adjusted by ${amount || "an amount"}${ref(m)}${reasonSuffix(e)}`;
    case "POLICY_EXEMPTION_CREATED":
      return "Deficit-policy exemption granted";
    case "POLICY_EXEMPTION_CANCELLED":
      return `Deficit-policy exemption ended${reasonSuffix(e)}`;
    case "EXPENSE_CATEGORY_CREATED":
      return typeof m.name === "string" ? `Expense category "${m.name}" created` : "Expense category created";
    default: {
      const human = e.action
        .toLowerCase()
        .split("_")
        .join(" ");
      const entity = e.entityType ? prettifyEntity(e.entityType) : "";
      return entity ? `${cap(human)} — ${entity}` : cap(human);
    }
  }
}

function refSuffix(m: Record<string, unknown>): string {
  const display = m.displayNumber ?? m.billNumber;
  return typeof display === "string" ? ` (${display})` : "";
}

function prettifyEntity(entityType: string): string {
  return entityType
    .toLowerCase()
    .split("_")
    .join(" ");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
