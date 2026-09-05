/**
 * Centralized notification and activity routing for the entire BoardOps system.
 * Maps any notification type or activity action code to its operational source route
 * where the user (ADMIN or RESIDENT) can review details or take immediate action.
 */

export function getNotificationTargetRoute(
  type: string | undefined | null,
  role: "ADMIN" | "RESIDENT",
  entityRef?: string | null
): string {
  const t = (type ?? "").toUpperCase();

  if (role === "ADMIN") {
    // Refunds are resolved from the post-billing Refund Center in Payments.
    // Keep this before generic FUND/DEFICIT routing so refund notifications do
    // not send the Admin back to the legacy Funds entry point.
    if (t.includes("REFUND")) {
      return "#/admin/payments/refunds";
    }

    // Payments: review resident payment proofs, approvals, rejections, voids
    if (t.includes("PAYMENT")) {
      return "#/admin/payments";
    }

    // Tasks: review duty submissions, assigned tasks, verification
    if (t.includes("TASK")) {
      return "#/admin/tasks";
    }

    // Meals & Leave: meal schedule, guest meals, leave windows, attendance
    if (
      t.includes("LEAVE") ||
      t.includes("MEAL") ||
      t.includes("GUEST") ||
      t.includes("ATTENDANCE") ||
      t.includes("DIET")
    ) {
      return "#/admin/meals";
    }

    // Policy exemption: if linked to a resident, go to resident 360
    if (t.includes("POLICY_EXEMPTION") && entityRef) {
      return `#/admin/residents/${entityRef}`;
    }

    // Residents: registration approvals, status changes, 360 profile
    if (
      t.includes("RESIDENT") ||
      t.includes("USER") ||
      t.includes("MEMBER") ||
      t.includes("REGISTRATION")
    ) {
      return entityRef ? `#/admin/residents/${entityRef}` : "#/admin/residents";
    }

    // Billing & Invoicing: period readiness, calculations, adjustments
    if (t.includes("BILL") || t.includes("INVOICE")) {
      return "#/admin/billing";
    }

    // Funds & Deficits: deficit warnings and resident-fund state.
    if (t.includes("DEFICIT") || t.includes("FUND")) {
      return "#/admin/funds";
    }

    // Expenses: grocery vouchers, mess operational bills
    if (t.includes("EXPENSE")) {
      return "#/admin/expenses";
    }

    // Announcements
    if (t.includes("ANNOUNCEMENT")) {
      return "#/admin/announcements";
    }

    // Formulas & Rules
    if (t.includes("FORMULA")) {
      return "#/admin/formulas";
    }

    // Calendar
    if (t.includes("CALENDAR")) {
      return "#/admin/calendar";
    }

    // Settings & Policies
    if (t.includes("POLICY") || t.includes("SETTING")) {
      return "#/admin/settings";
    }

    // Audit logs
    if (t.includes("AUDIT")) {
      return "#/admin/audit";
    }

    return "#/admin/notifications";
  }

  // RESIDENT role
  // Refund history is shown alongside the resident's payment history, not on
  // Billing, so refund notifications should open that actual destination.
  if (t.includes("REFUND")) {
    return "#/app/payments";
  }

  // Payments: balance, payment proofs, transaction history
  if (t.includes("PAYMENT")) {
    return "#/app/payments";
  }

  // Tasks: duty assignments, upload expense receipts/proof, status
  if (t.includes("TASK")) {
    return "#/app/tasks";
  }

  // Meals & Leave: meal schedule, meal off leave requests, guest booking
  if (
    t.includes("LEAVE") ||
    t.includes("MEAL") ||
    t.includes("GUEST") ||
    t.includes("ATTENDANCE") ||
    t.includes("DIET")
  ) {
    return "#/app/meals";
  }

  // Billing & Deficits: itemized breakdowns, monthly bills, deficit alerts
  if (t.includes("BILL") || t.includes("DEFICIT") || t.includes("FUND") || t.includes("INVOICE")) {
    return "#/app/billing";
  }

  // Profile & Membership: registration status, identity, policy exemptions
  if (
    t.includes("RESIDENT") ||
    t.includes("PROFILE") ||
    t.includes("USER") ||
    t.includes("MEMBER") ||
    t.includes("POLICY_EXEMPTION")
  ) {
    return "#/app/profile";
  }

  // Announcements & Updates
  if (t.includes("ANNOUNCEMENT")) {
    return "#/app/dashboard";
  }

  return "#/app/notifications";
}
