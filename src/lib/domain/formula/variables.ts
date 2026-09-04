/**
 * CENTRAL VARIABLE REGISTRY (spec §3-16, §28-29, §135-138)
 *
 * Three variable categories:
 *  - SYSTEM: automatically sourced from BoardOps data (read-only)
 *  - CUSTOM: admin-created manual variables with period value versioning
 *  - DERIVED: formula outputs (reusable in other formulas)
 *
 * Keys use lowercase snake_case: ^[a-z][a-z0-9_]*$
 */

export type VariableCategory = "SYSTEM" | "CUSTOM" | "DERIVED";
export type VariableValueType = "MONEY" | "NUMBER" | "PERCENTAGE" | "COUNT" | "DURATION" | "BOOLEAN";
export type VariableUnit = "INR" | "PERCENT" | "MEALS" | "RESIDENTS" | "DAYS" | "HOURS" | "NONE";
export type VariableScope = "GLOBAL" | "BILLING_PERIOD" | "RESIDENT" | "MEAL" | "DATE";
export type VariableFrequency = "CONSTANT" | "MONTHLY" | "ONE_TIME";

export interface VariableDefinitionSpec {
  key: string;
  displayName: string;
  description: string;
  category: VariableCategory;
  valueType: VariableValueType;
  unit: VariableUnit;
  scope: VariableScope;
  providerKey?: string;
  frequency?: VariableFrequency;
  formulaDefinitionId?: string;
  includes?: string;
  excludes?: string;
  isEditable?: boolean;
}

export const SYSTEM_VARIABLES: VariableDefinitionSpec[] = [
  // --- Residents ---
  {
    key: "total_residents",
    displayName: "Total Residents",
    description: "All approved resident records eligible for the selected period according to membership dates.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "RESIDENTS",
    scope: "BILLING_PERIOD",
    providerKey: "RESIDENT_ENGINE",
    includes: "All active and eligible residents.",
    excludes: "Residents who joined after the period or left before.",
  },
  {
    key: "total_inactive_residents",
    displayName: "Total Inactive Residents",
    description: "Residents marked inactive or departed within or before the period.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "RESIDENTS",
    scope: "BILLING_PERIOD",
    providerKey: "RESIDENT_ENGINE",
  },
  {
    key: "resident_joined_count",
    displayName: "Residents Joined",
    description: "Residents whose membership began within the selected billing period.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "RESIDENTS",
    scope: "BILLING_PERIOD",
    providerKey: "RESIDENT_ENGINE",
  },

  // --- Regular Meals (spec §8: CRITICAL: Regular resident meals only, NEVER includes guests!) ---
  {
    key: "total_resident_meals",
    displayName: "Total Resident Meals",
    description: "Total confirmed regular Resident meals (locked, past cutoff, or override) in the selected billing period. Guest meals and unconfirmed meals before cutoff are completely excluded.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "BILLING_PERIOD",
    providerKey: "MEAL_ENGINE",
    includes: "Locked, past-cutoff confirmed, and admin-override regular Resident ON meals.",
    excludes: "Guest meals and unconfirmed future meals before cutoff.",
  },
  {
    key: "total_resident_meals_off",
    displayName: "Resident Meals OFF",
    description: "Count of regular Resident meal instances marked OFF/skipped.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "BILLING_PERIOD",
    providerKey: "MEAL_ENGINE",
  },
  {
    key: "total_locked_resident_meals",
    displayName: "Locked Resident Meals",
    description: "Resident meals whose cutoff window has passed and state is locked.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "BILLING_PERIOD",
    providerKey: "MEAL_ENGINE",
  },
  {
    key: "resident_meal_count",
    displayName: "Resident Meal Count",
    description: "When evaluation context is one Resident: regular meals belonging to that Resident.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "RESIDENT",
    providerKey: "MEAL_ENGINE",
  },

  // --- Guest Meals (spec §9: guest meals separate from resident meals) ---
  {
    key: "total_guest_meals",
    displayName: "Total Guest Meals",
    description: "Sum of all confirmed or consumed guest meal quantities for the period.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "BILLING_PERIOD",
    providerKey: "GUEST_MEAL_ENGINE",
    includes: "All guest meal quantities.",
    excludes: "Resident's own regular meals.",
  },
  {
    key: "guest_meal_price",
    displayName: "Guest Meal Price",
    description: "Default or snapshot guest price configured for the period context.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "GUEST_MEAL_ENGINE",
    isEditable: true,
  },
  {
    key: "total_guest_income",
    displayName: "Total Guest Income",
    description: "Sum of actual guest charges billed or confirmed for the selected period.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "GUEST_MEAL_ENGINE",
    includes: "Actual billed amounts for guest meals.",
  },
  {
    key: "resident_guest_meals",
    displayName: "Resident Guest Meals",
    description: "Guest meal quantity hosted by the resident in the current context.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "RESIDENT",
    providerKey: "GUEST_MEAL_ENGINE",
  },
  {
    key: "guest_income_for_resident",
    displayName: "Resident Guest Income",
    description: "Guest charges belonging to the resident in the current context.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "RESIDENT",
    providerKey: "GUEST_MEAL_ENGINE",
  },

  // --- Kitchen Serving Count (spec §10: total_resident_meals + total_guest_meals) ---
  {
    key: "total_servings",
    displayName: "Total Servings",
    description: "Total kitchen servings prepared (total_resident_meals + total_guest_meals). Used for kitchen planning, not default billing denominator.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "MEALS",
    scope: "BILLING_PERIOD",
    providerKey: "KITCHEN_ENGINE",
    includes: "Regular resident meals + guest meals.",
  },

  // --- Expenses (spec §11, §12) ---
  {
    key: "total_approved_expense",
    displayName: "Total Approved Expenses",
    description: "Sum of all approved expenses for the period.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
  },
  {
    key: "total_market_expense",
    displayName: "Total Market Expense",
    description: "Only approved official market-related expenses (direct + verified market task submissions). Pending market submissions are excluded.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
    includes: "Official approved market expenses.",
    excludes: "Unverified market task submissions.",
  },
  {
    key: "total_grocery_expense",
    displayName: "Total Grocery Expense",
    description: "Approved expenses under Grocery category.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
  },
  {
    key: "total_vegetable_expense",
    displayName: "Total Vegetable Expense",
    description: "Approved expenses under Vegetables/Produce category.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
  },
  {
    key: "total_fuel_expense",
    displayName: "Total Fuel Expense",
    description: "Approved expenses under Fuel / Cooking Gas category.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
  },
  {
    key: "total_other_expense",
    displayName: "Total Other Expense",
    description: "Approved expenses under Other categories.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
  },
  {
    key: "expense_count",
    displayName: "Expense Count",
    description: "Number of approved expense records in the period.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "NONE",
    scope: "BILLING_PERIOD",
    providerKey: "EXPENSE_ENGINE",
  },

  // --- Payments (spec §13) ---
  {
    key: "total_payments_submitted",
    displayName: "Total Payments Submitted",
    description: "All payments submitted in the period regardless of verification status.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "PAYMENT_ENGINE",
  },
  {
    key: "total_payments_approved",
    displayName: "Total Payments Approved",
    description: "Verified and approved payments for the period.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "PAYMENT_ENGINE",
  },
  {
    key: "total_payments_pending",
    displayName: "Total Payments Pending",
    description: "Unverified payments awaiting Admin approval.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "PAYMENT_ENGINE",
  },
  {
    key: "total_deposits",
    displayName: "Total Deposits",
    description: "Total resident deposit payments received.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "PAYMENT_ENGINE",
  },
  {
    key: "total_refunds",
    displayName: "Total Refunds",
    description: "Approved refunds paid out during the period.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "PAYMENT_ENGINE",
  },
  {
    key: "total_credits",
    displayName: "Total Credits",
    description: "Total ledger credits applied to resident accounts.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "PAYMENT_ENGINE",
  },

  // --- Funds (spec §14) ---
  {
    key: "available_funds",
    displayName: "Available Funds",
    description: "Current ledger liquid funds balance available.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "FUNDS_ENGINE",
  },
  {
    key: "total_deficit",
    displayName: "Total Deficit",
    description: "Current institutional operational deficit, if expenses exceed funds.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "FUNDS_ENGINE",
  },
  {
    key: "total_credit_balance",
    displayName: "Total Credit Balance",
    description: "Aggregate resident positive credit balances.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "FUNDS_ENGINE",
  },
  {
    key: "total_outstanding_balance",
    displayName: "Total Outstanding Balance",
    description: "Aggregate unpaid resident bill balances.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "BILLING_PERIOD",
    providerKey: "FUNDS_ENGINE",
  },
  {
    key: "deficit_threshold",
    displayName: "Deficit Threshold",
    description: "Configured operational deficit limit before meal restriction policy triggers.",
    category: "SYSTEM",
    valueType: "MONEY",
    unit: "INR",
    scope: "GLOBAL",
    providerKey: "FUNDS_ENGINE",
    isEditable: true,
  },

  // --- Context & Date Variables (spec §16) ---
  {
    key: "days_in_month",
    displayName: "Days in Month",
    description: "Number of days in the current selected month.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "DAYS",
    scope: "BILLING_PERIOD",
    providerKey: "CONTEXT_ENGINE",
  },
  {
    key: "grace_period_days",
    displayName: "Grace Period Days",
    description: "Configured grace period days granted to residents in deficit before meal restriction takes effect.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "DAYS",
    scope: "GLOBAL",
    providerKey: "CONTEXT_ENGINE",
    isEditable: true,
  },
  {
    key: "selected_year",
    displayName: "Selected Year",
    description: "Calendar year of the evaluation context (e.g. 2026).",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "NONE",
    scope: "BILLING_PERIOD",
    providerKey: "CONTEXT_ENGINE",
  },
  {
    key: "selected_month",
    displayName: "Selected Month",
    description: "Calendar month number (1-12) of the evaluation context.",
    category: "SYSTEM",
    valueType: "COUNT",
    unit: "NONE",
    scope: "BILLING_PERIOD",
    providerKey: "CONTEXT_ENGINE",
  },
];

// Backwards compatibility aliases
export const VARIABLE_ALIASES: Record<string, string> = {
  total_active_residents: "total_residents",
  resident_count: "total_residents",
  total_resident_meals_on: "total_resident_meals",
  total_consumed_resident_meals: "total_resident_meals",
  total_expense: "total_approved_expense",
  total_approved_expenses: "total_approved_expense",
  total_collected: "total_payments_approved",
  remaining_funds: "available_funds",
  billing_period_days: "days_in_month",
  total_market_cost: "total_market_expense",
};

export const SYSTEM_VARIABLES_MAP: Record<string, VariableDefinitionSpec> = Object.fromEntries(
  SYSTEM_VARIABLES.map((v) => [v.key, v])
);

export function normalizeVariableKey(key: string): string {
  const trimmed = key.trim().toLowerCase();
  return VARIABLE_ALIASES[trimmed] ?? trimmed;
}

export function isValidVariableKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

export function generateKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "v_$1");
}

export const FORMULA_FUNCTION_SPECS = [
  { fn: "ROUND", label: "ROUND(x, decimals?)", description: "Rounds number to decimal places (default 2 / paise)." },
  { fn: "IF", label: "IF(cond, then, else)", description: "Returns then-value if condition evaluates to true / non-zero, else b." },
  { fn: "MIN", label: "MIN(a, b, ...)", description: "Minimum of the provided values." },
  { fn: "MAX", label: "MAX(a, b, ...)", description: "Maximum of the provided values." },
  { fn: "SUM", label: "SUM(a, b, ...)", description: "Sum of all provided values." },
  { fn: "ABS", label: "ABS(x)", description: "Absolute value of x." },
  { fn: "CEIL", label: "CEIL(x)", description: "Ceiling (rounds up to nearest integer)." },
  { fn: "FLOOR", label: "FLOOR(x)", description: "Floor (rounds down to nearest integer)." },
];

export const FORMULA_OPERATORS = ["+", "-", "*", "/", "(", ")", ">", ">=", "<", "<=", "==", "!="];

// Legacy exports for compatibility with existing imports
export type FormulaVariableScope = "PERIOD" | "RESIDENT";
export type FormulaVariableUnit = "MONEY_MINOR" | "COUNT";
export type FormulaVariableSpec = {
  name: string;
  label: string;
  description: string;
  scope: FormulaVariableScope;
  unit: FormulaVariableUnit;
};

export const FORMULA_VARIABLES: FormulaVariableSpec[] = SYSTEM_VARIABLES.map((v) => ({
  name: v.key,
  label: v.displayName,
  description: v.description,
  scope: v.scope === "RESIDENT" ? "RESIDENT" : "PERIOD",
  unit: v.valueType === "MONEY" ? "MONEY_MINOR" : "COUNT",
}));

export const VARIABLE_WHITELIST: Record<string, FormulaVariableSpec> = {
  ...Object.fromEntries(FORMULA_VARIABLES.map((v) => [v.name, v])),
  total_active_residents: {
    name: "total_active_residents",
    label: "Total Active Residents",
    description: "Alias for Total Residents",
    scope: "PERIOD",
    unit: "COUNT",
  },
  resident_count: {
    name: "resident_count",
    label: "Resident Count",
    description: "Alias for Total Residents",
    scope: "PERIOD",
    unit: "COUNT",
  },
  total_resident_meals_on: {
    name: "total_resident_meals_on",
    label: "Resident Meals ON",
    description: "Alias for Total Resident Meals",
    scope: "PERIOD",
    unit: "COUNT",
  },
  total_consumed_resident_meals: {
    name: "total_consumed_resident_meals",
    label: "Resident Consumed Meals",
    description: "Alias for Total Resident Meals",
    scope: "PERIOD",
    unit: "COUNT",
  },
  total_expense: {
    name: "total_expense",
    label: "Total Expenses",
    description: "Alias for Total Approved Expenses",
    scope: "PERIOD",
    unit: "MONEY_MINOR",
  },
  total_approved_expenses: {
    name: "total_approved_expenses",
    label: "Approved Expenses",
    description: "Alias for Total Approved Expense",
    scope: "PERIOD",
    unit: "MONEY_MINOR",
  },
  total_collected: {
    name: "total_collected",
    label: "Total Collected",
    description: "Alias for Total Payments Approved",
    scope: "PERIOD",
    unit: "MONEY_MINOR",
  },
  remaining_funds: {
    name: "remaining_funds",
    label: "Remaining Funds",
    description: "Alias for Available Funds",
    scope: "PERIOD",
    unit: "MONEY_MINOR",
  },
  billing_period_days: {
    name: "billing_period_days",
    label: "Billing Period Days",
    description: "Alias for Days in Month",
    scope: "PERIOD",
    unit: "COUNT",
  },
  total_market_cost: {
    name: "total_market_cost",
    label: "Total Market Cost",
    description: "Alias for Total Market Expense",
    scope: "PERIOD",
    unit: "MONEY_MINOR",
  },
};
