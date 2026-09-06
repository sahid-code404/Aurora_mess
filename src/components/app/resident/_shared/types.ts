/**
 * Resident API contract types (Task 5-b).
 * These mirror the LIVE /api/v1 responses (verified via curl against the
 * seeded backend) — see worklog for the envelope format:
 *   { ok: true, data: T, meta?: {...} }
 */

/* ---------------------------------- auth ---------------------------------- */

export interface SessionInstitution {
  name: string;
  timezone: string;
  currencyCode: string;
}

/* -------------------------------- dashboard ------------------------------- */

export interface DashboardGreeting {
  text: string;
  icon: string;
  fullName: string;
  localTime: string;
}

export interface DashboardKpis {
  mealsToday: number;
  monthlyMealCount?: number;
  availableBalance: number;
  availableBalanceFormatted: string;
  currentAmountToPay: number;
  currentAmountToPayFormatted: string;
  paymentStatus: string;
}

export interface DashboardTodayMeal {
  id: string;
  mealName: string;
  icon: string | null;
  mealType: string;
  serviceStartAt: string;
  serviceEndAt: string;
  cutoffAt: string;
  lockAt: string;
  locked: boolean;
  instanceStatus: string;
  myState: string | null;
  myReason: string | null;
  /** Design token for the circular gradient orb ("amber" | "emerald" | …). */
  colorToken: string | null;
  /** Optimistic-concurrency version of my residentMeal row (null = not materialized). */
  myVersion: number | null;
}

export interface ActivityNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  entityRef: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface PinnedAnnouncement {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  publishAt: string;
}

export interface DashboardData {
  greeting: DashboardGreeting;
  kpis: DashboardKpis;
  monthlyMealCount?: number;
  todayMeals: DashboardTodayMeal[];
  /** Today's guest meal requests (non-cancelled) for the agenda guest row. */
  todayGuests: DashboardTodayGuest[];
  recentActivity: ActivityNotification[];
  pinnedAnnouncements: PinnedAnnouncement[];
  notificationsPreview: ActivityNotification[];
}

export interface DashboardTodayGuest {
  id: string;
  mealInstanceId: string;
  mealName: string;
  quantity: number;
  unitPriceMinor: number;
  totalPriceMinor: number;
  note: string | null;
  status: string;
  cutoffAt: string;
}

/* ---------------------------------- meals --------------------------------- */

export interface MealMyState {
  residentMealId: string;
  effectiveState: "ON" | "OFF" | "ON_LEAVE" | "NOT_AVAILABLE";
  effectiveReason: string;
  locked: boolean;
  version: number;
  overridden: boolean;
}

export interface MealInstanceDto {
  id: string;
  mealInstanceId: string;
  name: string;
  icon: string | null;
  colorToken: string | null;
  mealType: string;
  serviceDate: string;
  serviceWindow: { startAt: string; endAt: string };
  cutoffAt: string;
  status: string;
  pricing: { strategy: string; fixedPriceMinor: number | null };
  myState: MealMyState;
}

export interface MealsMeta {
  from: string;
  to: string;
  today: string;
  timezone: string;
  monthKey: string;
  mealsOnMonth: number;
  mealsOffMonth: number;
  serverTime: string;
}

export interface ToggleResponse {
  state: "ON" | "OFF" | "ON_LEAVE" | "NOT_AVAILABLE";
  effectiveReason: string;
  locked: boolean;
  cutoffAt: string;
  version: number;
  residentMealId: string;
}

/* ------------------------------- guest meals ------------------------------ */

export interface GuestMealDto {
  id: string;
  mealInstanceId: string;
  mealName: string;
  serviceDate: string;
  quantity: number;
  unitPriceMinor: number;
  totalPriceMinor: number;
  note: string | null;
  status: string;
  createdAt: string;
  /** Instance cutoff instant — the client renders the "under cutoff" state. */
  cutoffAt: string;
}

/** PATCH /api/v1/guest-meals/[id] response. */
export interface GuestMealPatchResponse {
  id: string;
  mealInstanceId: string;
  quantity: number;
  unitPriceMinor: number;
  totalPriceMinor: number;
  status: string;
}

/** POST /api/v1/guest-meals/[id]/cancel response. */
export interface GuestMealCancelResponse {
  id: string;
  status: string;
  mealInstanceId: string;
  quantity: number;
  totalPriceMinor: number;
}

/* ------------------------------ leave requests ---------------------------- */

export interface MealOptionDto {
  id: string;
  name: string;
  icon: string | null;
  colorToken: string | null;
  mealType: string;
}

export interface LeavePreview {
  futureUnlockedMeals: number;
  alreadyLockedMeals: number;
}

export interface LeaveRequestDto {
  id: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  reason: string;
  mealScope: "ALL_MEALS" | "SELECTED_MEALS";
  selectedMeals: { id: string; name: string }[];
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | string;
  reviewReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  preview: LeavePreview;
}

/* --------------------------------- billing -------------------------------- */

export interface BillLineDetail {
  formula: string;
  marketCostMinor: number;
  guestIncomeMinor: number;
  totalMeals: number;
}

export interface BillLineDto {
  id: string;
  code: string;
  label: string;
  quantity: number | null;
  unitPriceMinor: number | null;
  amountMinor: number;
  amountFormatted: string;
  detail: BillLineDetail | null;
  sortOrder: number;
}

export interface BillDto {
  id: string;
  billNumber: string;
  residentId: string;
  period: { id: string; year: number; month: number; status: string };
  status: string;
  residentMealCount: number;
  guestMealCount: number;
  mealChargeMinor: number;
  guestChargeMinor: number;
  subtotalMinor: number;
  subtotalFormatted: string;
  adjustmentsMinor: number;
  paymentsMinor: number;
  totalDueMinor: number;
  totalDueFormatted: string;
  dueDate: string | null;
  generatedAt: string;
  lines?: BillLineDto[];
  adjustmentCount?: number;
  snapshotId?: string;
  adjustments?: unknown[];
  snapshot?: { mealChargeMinor: number; mealChargeFormatted: string; checksum: string } | null;
}

export interface BillingData {
  period: { year: number; month: number; monthLabel: string; status: string; billedAt: string | null };
  mealChargeFormatted: string;
  mealChargeSource: {
    version: number;
    expressionSource: string;
    humanPreview: string;
    inputMode: string;
  } | null;
  divideByZero: boolean;
  myMealsCount: number;
  myGuestCount: number;
  guestPriceMinor: number;
  guestPriceFormatted: string;
  estimateSubtotalMinor: number | null;
  estimateSubtotalFormatted: string;
  estimateIncomplete: boolean;
  estimateIncompleteNote: string | null;
  creditsMinor: number;
  creditsFormatted: string;
  creditsBreakdown: {
    availableMinor: number;
    availableFormatted: string;
    pendingPaymentsMinor: number;
    pendingPaymentsFormatted: string;
    chargesMinor: number;
    chargesFormatted: string;
    refundsIssuedMinor: number;
    carryForwardMinor: number;
  };
  currentAmountToPayMinor: number;
  currentAmountToPayFormatted: string;
  policyState: string;
  graceUntilIso: string | null;
  myBills: BillDto[];
}

/* --------------------------------- payments ------------------------------- */

export type PaymentMethod = "UPI" | "CASH" | "BANK_TRANSFER" | "OTHER";

export interface PaymentDto {
  id: string;
  displayNumber: string;
  amountMinor: number;
  amountFormatted: string;
  method: PaymentMethod;
  status: "PENDING" | "APPROVED" | "REJECTED" | "VOIDED" | string;
  reference: string | null;
  notes: string | null;
  hasProof: boolean;
  proofFileId: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
  idempotentKey: string | null;
}

export interface PaymentsMeta {
  nextCursor: string | null;
  depositsThisMonth: number;
  depositsThisMonthFormatted: string;
  totalDepositsAllTime?: number;
  totalDepositsAllTimeFormatted?: string;
  totalAvailableMinor?: number;
  totalAvailableFormatted?: string;
  policyState?: string;
  pendingCount: number;
  refundsThisMonth?: number;
  refundsThisMonthFormatted?: string;
}

export interface RefundDto {
  id: string;
  amountMinor: number;
  amountFormatted: string;
  mode: "CARRY_FORWARD" | "ISSUE_REFUND" | string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "VOIDED" | string;
  reason: string;
  destination: string | null;
  paymentId: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* ---------------------------------- tasks --------------------------------- */

export interface TaskItemDto {
  id: string;
  itemName: string;
  expectedQuantity: number;
  unit: string | null;
  estimatedUnitPriceMinor: number | null;
}

export interface TaskSubmissionItemDto {
  id: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface TaskSubmissionDto {
  id: string;
  status: string;
  comment: string | null;
  claimedTotalMinor: number;
  expenseId: string | null;
  proofFileId: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
  items: TaskSubmissionItemDto[];
}

export interface TaskDto {
  id: string;
  taskType: string;
  description: string;
  dueDate: string | null;
  notes: string | null;
  estimatedAmountMinor: number | null;
  status: string;
  rejectionReason: string | null;
  adminReviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  items: TaskItemDto[];
  submission: TaskSubmissionDto | null;
}

export interface TasksMeta {
  cursor: string | null;
  limit: number;
  countsByStatus: Record<string, number>;
  total: number;
}

/* --------------------------------- profile -------------------------------- */

export interface ProfileData {
  user: { id: string; email: string; role: string; status: string };
  profile: {
    fullName: string;
    phone: string | null;
    roomNumber: string | null;
    address: string | null;
    emergencyContact: string | null;
  } | null;
}

/* ------------------------------ notifications ----------------------------- */

export interface NotificationsMeta {
  unreadCount: number;
  nextCursor: string | null;
}

/* --------------------------------- helpers -------------------------------- */

/** money strings from the API can be "₹NaN.NaN" before the period closes. */
export function isMoneyUsable(formatted?: string | null): boolean {
  return !!formatted && !formatted.includes("NaN");
}
