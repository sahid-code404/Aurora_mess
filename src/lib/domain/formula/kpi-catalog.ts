/**
 * KPI CATALOG
 *
 * A small, human-facing map between BoardOps screens and the authoritative
 * Variable/Formula Registry. This catalog does NOT contain arithmetic. A KPI
 * either points at a system fact, an editable setting/custom variable, or a
 * derived Formula output. That keeps the UI transparent without letting Admins
 * redefine ledger/accounting facts.
 */

export type KpiCatalogPage =
  | "Dashboard"
  | "Meals"
  | "Expenses"
  | "Payments"
  | "Funds"
  | "Billing"
  | "Custom";

export interface KpiCatalogSpec {
  key: string;
  label: string;
  page: KpiCatalogPage;
  sourceKey: string;
  description: string;
}

export const BUILTIN_KPI_CATALOG: KpiCatalogSpec[] = [
  {
    key: "dashboard_residents",
    label: "Residents",
    page: "Dashboard",
    sourceKey: "total_residents",
    description: "Residents eligible for the selected billing period.",
  },
  {
    key: "dashboard_available_funds",
    label: "Available Funds",
    page: "Dashboard",
    sourceKey: "available_funds",
    description: "Liquid institution cash from the authoritative ledger.",
  },
  {
    key: "dashboard_meal_charge",
    label: "Meal Charge",
    page: "Dashboard",
    sourceKey: "meal_charge",
    description: "Current calculated resident meal rate.",
  },
  {
    key: "meals_resident_meals",
    label: "Resident Meals",
    page: "Meals",
    sourceKey: "total_resident_meals",
    description: "Confirmed regular resident meals for the period.",
  },
  {
    key: "meals_guest_meals",
    label: "Guest Meals",
    page: "Meals",
    sourceKey: "total_guest_meals",
    description: "Confirmed or consumed guest meal quantities.",
  },
  {
    key: "meals_total_servings",
    label: "Kitchen Servings",
    page: "Meals",
    sourceKey: "total_servings",
    description: "Resident meals plus guest meals for kitchen planning.",
  },
  {
    key: "expenses_meal_cost",
    label: "Meal Cost",
    page: "Expenses",
    sourceKey: "total_meal_expense",
    description: "Approved Meal Cost expenses used by the meal-rate formula.",
  },
  {
    key: "expenses_extra_cost",
    label: "Extra Cost",
    page: "Expenses",
    sourceKey: "total_extra_expense",
    description: "Approved Extra Cost expenses excluded from meal charge by default.",
  },
  {
    key: "expenses_total",
    label: "Total Expenses",
    page: "Expenses",
    sourceKey: "total_approved_expense",
    description: "All approved expenses for the selected period.",
  },
  {
    key: "payments_approved",
    label: "Approved Payments",
    page: "Payments",
    sourceKey: "total_payments_approved",
    description: "Verified resident payments received during the period.",
  },
  {
    key: "payments_pending",
    label: "Pending Payment Amount",
    page: "Payments",
    sourceKey: "total_payments_pending",
    description: "Submitted payment value still waiting for Admin review.",
  },
  {
    key: "payments_refunds",
    label: "Cash Refunds",
    page: "Payments",
    sourceKey: "total_refunds",
    description: "Completed cash refunds only; carry-forward is separate.",
  },
  {
    key: "payments_carry_forward",
    label: "Carry Forward",
    page: "Payments",
    sourceKey: "total_carry_forward",
    description: "Excess resident credit retained for later bills.",
  },
  {
    key: "funds_available",
    label: "Available Funds",
    page: "Funds",
    sourceKey: "available_funds",
    description: "Current positive CASH ledger balance.",
  },
  {
    key: "funds_resident_credit",
    label: "Resident Credit Liability",
    page: "Funds",
    sourceKey: "total_credit_balance",
    description: "Total positive resident credit that the institution owes residents.",
  },
  {
    key: "funds_outstanding",
    label: "Outstanding Bills",
    page: "Funds",
    sourceKey: "total_outstanding_balance",
    description: "Resident bill amount still outstanding.",
  },
  {
    key: "funds_deficit",
    label: "Cash Deficit",
    page: "Funds",
    sourceKey: "total_deficit",
    description: "Institution cash deficit when the ledger CASH balance is negative.",
  },
  {
    key: "billing_meal_charge",
    label: "Meal Charge",
    page: "Billing",
    sourceKey: "meal_charge",
    description: "Per-meal rate used by the current open billing calculation.",
  },
  {
    key: "billing_meal_expense",
    label: "Meal Expenses Used",
    page: "Billing",
    sourceKey: "total_meal_expense",
    description: "Meal Cost pool available to the active formula.",
  },
  {
    key: "billing_guest_income",
    label: "Guest Income",
    page: "Billing",
    sourceKey: "total_guest_income",
    description: "Guest income available to the active formula.",
  },
  {
    key: "billing_resident_meals",
    label: "Resident Meals",
    page: "Billing",
    sourceKey: "total_resident_meals",
    description: "Resident meal denominator available to the active formula.",
  },
];
