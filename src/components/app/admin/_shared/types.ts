"use client";

/**
 * Shared API response types for the admin views — derived from live
 * endpoint shapes (curl-verified against the seeded backend).
 */

/* ---- funds (shared by payments detail, residents, resident360, funds) ---- */

export interface FundsSummary {
  residentId: string;
  creditsMinor: number;
  pendingPaymentsMinor: number;
  chargesMinor: number;
  refundsIssuedMinor: number;
  carryForwardMinor: number;
  availableMinor: number;
  amountToPayMinor: number;
  deficitMinor: number;
  policyState: "EXEMPTED" | "AVAILABLE" | "GRACE_PERIOD" | "RESTRICTED" | string;
  graceUntilIso: string | null;
  thresholdMinor: number;
  creditsFormatted?: string;
  pendingPaymentsFormatted?: string;
  chargesFormatted?: string;
  availableFormatted?: string;
  amountToPayFormatted?: string;
  deficitFormatted?: string;
}

/* ---- payments ---- */

export interface PaymentRow {
  id: string;
  displayNumber: string;
  amountMinor: number;
  amountFormatted: string;
  method: "UPI" | "CASH" | "BANK_TRANSFER" | "OTHER" | string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "VOIDED" | string;
  reference: string | null;
  notes: string | null;
  hasProof: boolean;
  proofFileId: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
  residentId: string;
  residentName: string;
}

export interface PaymentDetail {
  payment: PaymentRow;
  history: { id: string; fromStatus: string | null; toStatus: string; changedByUserId: string | null; reason: string | null; createdAt: string }[];
  resident: { id: string; email: string; status: string; fullName: string; roomNumber: string | null };
  residentFunds: FundsSummary | null;
}

/* ---- residents ---- */

export interface ResidentRow {
  id: string;
  email: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING_APPROVAL" | "CHANGES_REQUESTED" | "REJECTED" | "PENDING_DELETION" | string;
  createdAt: string;
  membershipEffectiveFrom: string | null;
  membershipEffectiveUntil: string | null;
  profile: { fullName: string; phone: string | null; roomNumber: string | null };
  funds: FundsSummary | null;
}

export interface Resident360 {
  user: {
    id: string;
    email: string;
    role: string;
    status: string;
    createdAt: string;
    membershipEffectiveFrom: string | null;
    membershipEffectiveUntil: string | null;
  };
  profile: { fullName: string; phone: string | null; roomNumber: string | null; address: string | null; emergencyContact: string | null };
  statusHistory: { id: string; fromStatus: string | null; toStatus: string; reason: string | null; changedByUserId: string | null; createdAt: string }[];
  funds: FundsSummary | null;
  payments: { id: string; displayNumber: string; amountMinor: number; method: string; reference: string | null; status: string; submittedAt: string }[];
  bills: { id: string; billNumber: string; status: string; totalDueMinor: number; subtotalMinor: number; dueDate: string; generatedAt: string; lineCount: number }[];
  tasks: { id: string; description: string; status: string; dueDate: string | null; estimatedAmountMinor: number | null; createdAt: string }[];
  refunds?: {
    id: string;
    amountMinor: number;
    amountFormatted: string;
    mode: string;
    status: string;
    reason: string;
    destination: string | null;
    reversalJournalId: string | null;
    voidReason: string | null;
    voidedByUserId: string | null;
    voidedAt: string | null;
    createdAt: string;
    completedAt: string | null;
  }[];
  leave: unknown[];
  audit: unknown[];
}

/* ---- meal configuration ---- */

export interface MealDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  colorToken: string | null;
  mealType: string;
  active: boolean;
  defaultState: "ON" | "OFF" | string;
  defaultVisible: boolean;
  pricingStrategy: "FORMULA" | "FIXED" | string;
  fixedPriceMinor: number | null;
  scheduleStrategy: "DAILY" | "WEEKDAYS" | "ONE_TIME" | string;
  weekdaysCsv: string | null;
  specificDate: string | null;
  serviceStartLocal: string;
  serviceEndLocal: string;
  cutoffStrategy: "SAME_DAY" | "PREVIOUS_DAY" | "CUSTOM_OFFSET" | string;
  cutoffOffsetDays: number | null;
  cutoffLocalTime: string;
  internalNotes: string | null;
  archivedAt: string | null;
  deleteRequestedAt: string | null;
  deletionRequest: {
    id: string;
    status: "QUEUED" | "SCHEDULED" | "BLOCKED" | "COMPLETED" | "CANCELLED" | string;
    requestedAt: string;
    scheduledFor: string | null;
    reason: string | null;
    blockedReason: string | null;
    completedAt: string | null;
    cancelReason: string | null;
    cancelledByUserId: string | null;
    cancelledAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  latestVersion?: { id: string; version: number; createdAt: string } | null;
  versions?: { id: string; version: number; configSnapshot: Record<string, unknown> | null; createdByUserId: string | null; createdAt: string }[];
}

/* ---- billing ---- */

export interface BillingPeriodRow {
  id: string;
  year: number;
  month: number;
  monthLabel: string;
  status: "OPEN" | "BILLED" | "REOPENED" | string;
  generationState: string | null;
  billedAt: string | null;
  mealChargeMinorSnapshot: number | null;
  guestPriceMinorSnapshot: number | null;
  billCount: number;
  createdAt: string;
}

export interface BillRow {
  id: string;
  billNumber: string;
  residentId: string;
  residentName?: string;
  period?: { id: string; year: number; month: number; status: string };
  status: string;
  residentMealCount: number;
  guestMealCount: number;
  mealChargeMinor?: number;
  guestChargeMinor?: number;
  subtotalMinor: number;
  subtotalFormatted?: string;
  adjustmentsMinor: number;
  paymentsMinor: number;
  paymentsFormatted?: string;
  totalDueMinor: number;
  totalDueFormatted?: string;
  dueDate: string | null;
  generatedAt: string;
}

/* ---- expenses ---- */

export interface ExpenseRow {
  id: string;
  displayNumber: string;
  dateKey: string | null;
  date: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "VOIDED" | string;
  source: "DIRECT" | "TASK" | string;
  description: string;
  comment: string | null;
  totalMinor: number;
  totalFormatted: string;
  categoryId: string | null;
  categoryName: string | null;
  hasProof: boolean;
  proofFileId: string | null;
  itemCount: number | null;
  submittedByUserId: string | null;
  approvedByUserId: string | null;
  reviewedAt: string | null;
  journalId: string | null;
  reversalJournalId: string | null;
  voidReason: string | null;
  createdAt: string;
  items?: {
    id: string;
    itemName: string;
    quantity: number;
    unit: string | null;
    unitPriceMinor: number;
    unitPriceFormatted?: string;
    lineTotalMinor: number;
    lineTotalFormatted?: string;
  }[];
}

export interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
  expenseCount: number;
  createdAt: string;
}

/* ---- tasks ---- */

export interface TaskItemRow {
  id: string;
  itemName: string;
  expectedQuantity: number | null;
  unit: string | null;
  estimatedUnitPriceMinor: number | null;
}

export interface TaskSubmissionItemRow {
  id: string;
  itemName: string;
  quantity: number;
  unit: string | null;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface TaskRow {
  id: string;
  taskType: "MARKET_PURCHASE" | "GENERAL" | string;
  description: string;
  assignedResidentId: string;
  assignedByUserId: string;
  residentName: string;
  roomNumber: string | null;
  dueDate: string | null;
  notes: string | null;
  estimatedAmountMinor: number | null;
  status: string;
  rejectionReason: string | null;
  adminReviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  items: TaskItemRow[];
  submission: {
    id: string;
    status: string;
    comment: string | null;
    claimedTotalMinor: number;
    expenseId: string | null;
    proofFileId: string | null;
    submittedAt: string;
    reviewedAt: string | null;
    reviewReason: string | null;
    items: TaskSubmissionItemRow[];
  } | null;
}

/* ---- formulas & variables ---- */

export interface FormulaVersion {
  id: string;
  formulaDefinitionId?: string;
  version: number;
  inputMode: "FORMULA" | "NATURAL_LANGUAGE" | string;
  expressionSource: string | null;
  naturalSource: string | null;
  normalizedExpression?: string | null;
  humanPreview: string | null;
  outputType?: string;
  checksum: string;
  reason: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status?: string;
  active: boolean;
  createdAt: string;
}

export interface VariableItem {
  id?: string;
  key: string;
  displayName: string;
  description: string;
  category: "SYSTEM" | "CUSTOM" | "DERIVED";
  valueType: "MONEY" | "NUMBER" | "PERCENTAGE" | "COUNT" | "DURATION" | "BOOLEAN";
  unit: "INR" | "PERCENT" | "MEALS" | "RESIDENTS" | "DAYS" | "HOURS" | "NONE" | string;
  scope: string;
  frequency?: string;
  valueRaw: number;
  valueFormatted: string;
  isPinned: boolean;
  isEditable?: boolean;
  providerKey?: string;
  usedByFormulas: string[];
  effectivePeriod?: string;
}

export interface FormulaDefinitionItem {
  id: string;
  name: string;
  description: string | null;
  outputVariableKey: string;
  scope: string;
  status: string;
  activeVersion: FormulaVersion | null;
  versionsCount: number;
}

export interface FormulaVariableValue {
  name: string;
  label: string;
  unit: string;
  value: number;
  valueFormatted: string;
}

export interface FormulaPreviewExample {
  period: { year: number; month: number; key?: string };
  variables: FormulaVariableValue[];
  steps: string[];
  resultMinor: number | null;
  resultFormatted: string;
  resultPerMealMinor: number | null;
  resultPerMealFormatted: string | null;
  divideByZero: boolean;
  divideByZeroMessage?: string | null;
}

export interface FormulaExplanationData {
  outputVariableKey: string;
  outputDisplayName: string;
  friendlyExpression: string;
  finalResultFormatted: string;
  steps: {
    stepNumber: number;
    description: string;
    resultMinor?: number;
    resultFormatted?: string;
  }[];
}

export interface FormulaPreviewResult {
  ast: unknown;
  humanPreview: string;
  formulaText: string;
  formattedExpression?: string;
  naturalSource: string | null;
  recognizedVariables?: { term: string; variableKey: string; displayName: string }[];
  ambiguities?: {
    id: string;
    question: string;
    options: { label: string; variableKey: string; description: string }[];
  }[];
  suggestedCustomVariable?: {
    name: string;
    key: string;
    valueType: string;
    unit: string;
    value: number;
  } | null;
  outputVariableKey?: string;
  isNegative?: boolean;
  negativeWarning?: string | null;
  example: FormulaPreviewExample;
  explanation?: FormulaExplanationData;
  downstreamFormulas?: string[];
}

/* ---- calendar ---- */

export interface CalendarEventRow {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  type: "HOLIDAY" | "FESTIVAL" | "MAINTENANCE" | "CUSTOM" | string;
  disableMeals: boolean;
  mealScope: "ALL_MEALS" | "SELECTED_MEALS";
  selectedMeals: { id: string; name: string }[];
  createdAt: string;
}

/* ---- notifications ---- */

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  entityRef: string | null;
  readAt: string | null;
  createdAt: string;
}

/* ---- audit ---- */

export interface AuditRow {
  id: string;
  action: string;
  actorUserId: string | null;
  actorRole: string | null;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  beforeSummary: string | null;
  afterSummary: string | null;
  metadata: unknown;
  requestId: string | null;
  occurredAt: string;
  ip: string | null;
  userAgent: string | null;
}

/* ---- announcements ---- */

export interface AnnouncementRow {
  id: string;
  institutionId: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  target: string;
  publishAt: string;
  expiresAt: string | null;
  pinned: boolean;
  createdByUserId: string;
  createdAt: string;
}

/* ---- settings / policies ---- */

export interface AdminSettings {
  institution: { name: string; timezone: string; currencyCode: string; currencyMinorDigits: number };
  settings: {
    deficitThresholdMinor: number;
    gracePeriodDays: number;
    restrictMealsOnDeficit: boolean;
    deficitPolicyEnabled: boolean;
    billingDueDays: number;
    guestMealPriceMinor: number;
  };
  security: {
    maxLoginAttempts: number;
    loginWindowMinutes: number;
    sessionIdleMinutes: number;
    sensitiveActionMinutes: number;
    requireReasonOnOverride: boolean;
  };
}

export interface PolicyRow {
  id: string;
  type: string;
  title: string;
  status: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  latestVersion: { id: string; version: number; publishedAt: string } | null;
  versions: { id: string; version: number; publishedAt: string; content: string }[];
}

/* ---- policy exemptions ---- */

export interface PolicyExemptionRow {
  id: string;
  residentId: string;
  residentName?: string;
  policyType: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  approvedByUserId: string;
  createdAt: string;
}
