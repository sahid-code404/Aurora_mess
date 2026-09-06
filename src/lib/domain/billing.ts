/**
 * BILLING — period lifecycle, readiness gate, immutable snapshot and bill
 * generation (spec §52-59).
 *
 * INVARIANTS:
 *  - Billing periods are unique per (institution, year, month); only the CURRENT
 *    month may ever be created (no future months — §52).
 *  - Generation is serialized through a status guard (OPEN → CLOSING) inside a
 *    single transaction: concurrent or repeated generation fails cleanly with
 *    BILLING_ALREADY_BILLED / BILLING_PERIOD_CLOSED.
 *  - Readiness is re-run INSIDE the transaction — anything unready rolls the
 *    period back to OPEN (no half-closed states).
 *  - ALL inputs are frozen into BillingSnapshot (payload + sha256 checksum).
 *    BILLED periods are never recalculated; corrections happen via bill
 *    adjustments only (§59).
 *  - Every bill carries provenance lines (quantity × unit price, payments
 *    applied, formula text) — never an unexplained total (§58, §275).
 *  - Journals: per bill, Dr RESIDENT_FUNDS (subtotal) / Cr MEAL_CHARGE_INCOME
 *    (resident meal part) + Cr GUEST_INCOME (guest part), refType BILL.
 */
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { getInstitution } from "@/lib/institution";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { formatMinor, multiplyRoundHalfUp } from "@/lib/money";
import { nextBillNumbers } from "@/lib/ids";
import { addDaysToKey, localDateMidnightUtc, monthBoundsInTz, zonedTimeToUtc } from "@/lib/time";
import { postJournal, reconcileInstitution, type JournalLine } from "./ledger";
import { FormulaAst } from "./formula/ast";
import { evaluateFormula } from "./formula/evaluator";
import { gatherPeriodVariables, periodBounds } from "./formula/period-variables";
import { resolveFormulaVersionForPeriod } from "./formula/versions";
import { billingSnapshotChecksum } from "./billing-integrity";
import { isBillPastDueDate } from "./bill-status";
import { refreshGuestMealLifecycle } from "./guest-meal-lifecycle";

const UNSETTLED_BILL_STATUSES = ["GENERATED", "PARTIALLY_PAID", "OVERDUE"];
const GUEST_CONFIRMED = ["CONFIRMED", "LOCKED", "CONSUMED"];

export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1))
  );
}

/** Whether a billing month has completed in the given timezone. */
export function isMonthEnded(year: number, month: number, tz = "Asia/Kolkata", now = new Date()): boolean {
  const bounds = periodBounds(year, month, tz);
  return now >= bounds.endInstant;
}

/** The 5th day of the month immediately following the billing period (00:00 local time). */
export function autoBillingDueDate(year: number, month: number, tz = "Asia/Kolkata"): Date {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return zonedTimeToUtc(nextYear, nextMonth, 5, 0, 0, tz);
}

/** Whether auto-generation is due for a period (on or after 5th of next month). */
export function isAutoBillingDue(year: number, month: number, tz = "Asia/Kolkata", now = new Date()): boolean {
  return now >= autoBillingDueDate(year, month, tz);
}

/** Filter for confirmed resident meals (matching formula provider logic). */
export function confirmedResidentMealFilter(
  institutionId: string,
  serviceDateRange: { gte: Date; lt: Date },
  now = new Date()
) {
  return {
    institutionId,
    effectiveState: "ON",
    mealInstance: { serviceDate: serviceDateRange },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "ON" },
      { mealInstance: { cutoffAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };
}

/** Current month period (institution tz). NEVER creates future months (§52). */
export async function getOrCreateOpenPeriod(institutionId: string, tz?: string): Promise<any> {
  const inst = tz ? null : await getInstitution(institutionId);
  const timeZone = tz ?? inst?.timezone ?? "Asia/Kolkata";
  const b = monthBoundsInTz(new Date(), timeZone);
  const existing = await db.billingPeriod.findUnique({
    where: { institutionId_year_month: { institutionId, year: b.year, month: b.month } },
  });
  if (existing) return existing;
  try {
    return await db.billingPeriod.create({
      data: { institutionId, year: b.year, month: b.month, status: "OPEN" },
    });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "P2002") {
      // Racing creator won — read theirs.
      return await db.billingPeriod.findUniqueOrThrow({
        where: { institutionId_year_month: { institutionId, year: b.year, month: b.month } },
      });
    }
    throw error;
  }
}

export async function listPeriods(institutionId: string): Promise<any[]> {
  const periods = await db.billingPeriod.findMany({
    where: { institutionId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  const counts = await db.bill.groupBy({
    by: ["billingPeriodId"],
    where: { institutionId },
    _count: { _all: true },
  });
  const countMap = new Map<string, number>(counts.map((c: any) => [c.billingPeriodId, c._all ?? c._count?._all ?? 0]));
  return periods.map((p: any) => ({
    id: p.id,
    year: p.year,
    month: p.month,
    monthLabel: monthLabel(p.year, p.month),
    status: p.status,
    generationState: p.generationState ?? null,
    billedAt: p.billedAt ? p.billedAt.toISOString() : null,
    mealChargeMinorSnapshot: p.mealChargeMinorSnapshot ?? null,
    guestPriceMinorSnapshot: p.guestPriceMinorSnapshot ?? null,
    billCount: countMap.get(p.id) ?? 0,
    createdAt: p.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// READINESS (spec §53)
// ---------------------------------------------------------------------------

export type ReadinessCheck = {
  key: string;
  label: string;
  pass: boolean;
  detail?: string;
};

export type BillingReadiness = {
  checks: ReadinessCheck[];
  ready: boolean;
  /** Raw whitelisted formula variables resolved for this period (for the snapshot). */
  variables: Record<string, number>;
  summary: {
    residentCount: number;
    residentMealCount: number;
    guestMealCount: number;
    guestIncomeMinor: number;
    eligibleExpensesMinor: number;
    approvedPaymentsMinor: number;
    mealChargeMinor: number | null;
    guestPriceMinor: number;
    formulaVersion: { version: number; expressionSource: string; humanPreview: string } | null;
  };
};

/**
 * Full readiness evaluation. `client` lets generateBilling re-run everything
 * inside its transaction (the ledger-reconcile counts mirror
 * reconcileInstitution from @/lib/domain/ledger — that function only accepts
 * the global client, so the tx path recomputes identical counts).
 */
export async function computeReadiness(periodId: string, client: any = db): Promise<BillingReadiness> {
  const period = await client.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  const inst = await getInstitution(period.institutionId);
  const tz = inst?.timezone ?? "Asia/Kolkata";
  const bounds = periodBounds(period.year, period.month, tz);
  const serviceDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };

  // Billing is a lifecycle boundary: persist every ended guest booking as
  // CONSUMED before formula variables/readiness/snapshots are resolved. This
  // must not depend on whether a Resident/Admin happened to open a guest page.
  await refreshGuestMealLifecycle({
    institutionId: period.institutionId,
    from: bounds.startAt,
    to: new Date(bounds.endExclusiveAt.getTime() - 1),
    client,
  });

  const checks: ReadinessCheck[] = [];

  // 1. Period must be OPEN.
  checks.push({
    key: "period_open",
    label: "Period is open",
    pass: period.status === "OPEN",
    detail:
      period.status === "BILLED"
        ? "This period has already been billed."
        : period.status === "CLOSING"
          ? "A billing run is currently in progress."
          : period.status === "REOPENED"
            ? "This period was reopened after billing — bills remain authoritative."
            : undefined,
  });

  // 2. Month must have ended (billing lifecycle rule: bills can ONLY be generated after month end).
  const now = new Date();
  const monthEnded = isMonthEnded(period.year, period.month, tz, now);
  const autoDueDate = autoBillingDueDate(period.year, period.month, tz);
  const autoDueFormatted = new Intl.DateTimeFormat("en-IN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  }).format(autoDueDate);
  const opensFormatted = new Intl.DateTimeFormat("en-IN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  }).format(bounds.endInstant);

  checks.push({
    key: "month_ended",
    label: monthEnded ? "Billing month has ended" : "Billing month has not ended yet",
    pass: monthEnded,
    detail: monthEnded
      ? undefined
      : `Bills can only be generated after the billing month ends (manual opens on ${opensFormatted}, auto-generates on ${autoDueFormatted}).`,
  });

  // 3. No unreviewed payments (unprocessed financial records — §53).
  const pendingPayments = await client.payment.count({
    where: { institutionId: period.institutionId, status: "PENDING" },
  });
  checks.push({
    key: "pending_payments",
    label:
      pendingPayments === 0
        ? "No payments waiting for review"
        : `${pendingPayments} payment${pendingPayments === 1 ? "" : "s"} ${
            pendingPayments === 1 ? "is" : "are"
          } still waiting for review`,
    pass: pendingPayments === 0,
  });

  // 3. A formula version must cover this period.
  const formulaVersion = await resolveFormulaVersionForPeriod(period.institutionId, bounds.startAt, "meal_charge", client);
  checks.push({
    key: "formula_version",
    label: "Active meal charge formula",
    pass: Boolean(formulaVersion),
    detail: formulaVersion ? undefined : "No active meal charge formula covers this period.",
  });

  // 4. Formula must evaluate (divide-by-zero when 0 resident meals) and must
  //     not produce a negative charge (guest income / exemptions exceeding cost
  //     would otherwise bill negative amounts — audit 9-a finding #3).
  const variables = await gatherPeriodVariables(period.institutionId, period.year, period.month, undefined, client);
  let mealChargeMinor: number | null = null;
  let mealChargeProblem: string | null = null;
  if (formulaVersion) {
    try {
      mealChargeMinor = evaluateFormula(JSON.parse(formulaVersion.compiledAstJson) as FormulaAst, variables);
    } catch (error) {
      if (error instanceof ApiError && error.code === CODES.FORMULA_DIVIDE_BY_ZERO) {
        mealChargeProblem = "No resident meals recorded — the per-meal charge cannot be calculated";
      } else {
        mealChargeProblem = "The formula could not be evaluated for this period";
      }
    }
    if (mealChargeMinor != null && mealChargeMinor < 0) {
      mealChargeProblem =
        "The formula produced a negative per-meal charge — review this period's expenses and guest income before billing";
    }
  }
  checks.push({
    key: "meal_charge_computable",
    label: "Per-meal charge is computable",
    pass: mealChargeMinor != null && mealChargeMinor >= 0,
    detail: mealChargeProblem ?? undefined,
  });

  // 5. One authoritative reconciliation kernel shared with the ledger view.
  //    This includes refunds, reversal links, bill journals, and journal shape.
  const reconciliation = await reconcileInstitution(period.institutionId, client);
  checks.push({
    key: "ledger_reconciled",
    label: "Ledger reconciled with financial records",
    pass: reconciliation.balanced,
    detail: reconciliation.problems.length > 0 ? reconciliation.problems.join("; ") : undefined,
  });

  // 6. No duplicate resident meals (same resident on the same instance twice).
  const residentMealRows = await client.residentMeal.findMany({
    where: { institutionId: period.institutionId, mealInstance: { serviceDate: serviceDateRange } },
    select: { residentId: true, mealInstanceId: true },
  });
  const rmSeen = new Set<string>();
  let duplicateResidentMeals = 0;
  for (const row of residentMealRows) {
    const key = `${row.residentId}|${row.mealInstanceId}`;
    if (rmSeen.has(key)) duplicateResidentMeals += 1;
    else rmSeen.add(key);
  }
  checks.push({
    key: "no_duplicate_resident_meals",
    label: "No duplicate resident meal entries",
    pass: duplicateResidentMeals === 0,
    detail: duplicateResidentMeals > 0 ? `${duplicateResidentMeals} duplicate resident meal entries` : undefined,
  });

  // 7. No duplicate meal instances (definition + serviceDate). Guarded by a DB
  //    unique constraint — verified here anyway as a safety net.
  const instanceRows = await client.mealInstance.findMany({
    where: { institutionId: period.institutionId, serviceDate: serviceDateRange },
    select: { mealDefinitionId: true, serviceDate: true },
  });
  const miSeen = new Set<string>();
  let duplicateInstances = 0;
  for (const row of instanceRows) {
    const key = `${row.mealDefinitionId}|${row.serviceDate.toISOString()}`;
    if (miSeen.has(key)) duplicateInstances += 1;
    else miSeen.add(key);
  }
  checks.push({
    key: "no_duplicate_meal_instances",
    label: "Meal instances are unique per date",
    pass: duplicateInstances === 0,
    detail: duplicateInstances > 0 ? `${duplicateInstances} duplicate meal instances` : undefined,
  });

  // 8. Guest meal totals reconcile (quantity × unit price == stored total).
  const guestRows = await client.guestMealRequest.findMany({
    where: {
      institutionId: period.institutionId,
      status: { in: GUEST_CONFIRMED },
      mealInstance: { serviceDate: serviceDateRange },
    },
    select: { quantity: true, unitPriceMinor: true, totalPriceMinor: true },
  });
  let guestStored = 0;
  let guestRecomputed = 0;
  for (const g of guestRows) {
    guestStored += g.totalPriceMinor;
    guestRecomputed += multiplyRoundHalfUp(g.quantity, g.unitPriceMinor);
  }
  checks.push({
    key: "guest_totals_reconcile",
    label: "Guest meal totals reconcile",
    pass: guestStored === guestRecomputed,
    detail:
      guestStored !== guestRecomputed
        ? `Guest totals off by ${Math.abs(guestStored - guestRecomputed)} paise (recomputed ${guestRecomputed} vs stored ${guestStored})`
        : undefined,
  });

  // 9. No pending expenses.
  const pendingExpenses = await client.expense.count({
    where: { institutionId: period.institutionId, status: "PENDING" },
  });
  checks.push({
    key: "pending_expenses",
    label:
      pendingExpenses === 0
        ? "No expenses waiting for review"
        : `${pendingExpenses} expense${pendingExpenses === 1 ? "" : "s"} waiting for review`,
    pass: pendingExpenses === 0,
  });

  // 10. No submitted task submissions awaiting verification (scoped to this
  //     institution via the task — TaskSubmission has no institution column).
  const submittedTasks = await client.taskSubmission.count({
    where: { status: "SUBMITTED", task: { institutionId: period.institutionId } },
  });
  checks.push({
    key: "submitted_tasks",
    label:
      submittedTasks === 0
        ? "No task submissions awaiting verification"
        : `${submittedTasks} task submission${submittedTasks === 1 ? "" : "s"} need verification`,
    pass: submittedTasks === 0,
  });

  // Summary + counts.
  const [residents, mealCountAgg, guestAgg, expenseAgg, paymentAgg] = await Promise.all([
    client.user.findMany({
      where: { institutionId: period.institutionId, role: "RESIDENT", status: { in: ["ACTIVE", "INACTIVE", "PENDING_DELETION"] } },
      select: { id: true, membershipEffectiveFrom: true, membershipEffectiveUntil: true },
    }),
    client.residentMeal.count({
      where: confirmedResidentMealFilter(period.institutionId, serviceDateRange, now),
    }),
    client.guestMealRequest.aggregate({
      _sum: { quantity: true, totalPriceMinor: true },
      where: {
        institutionId: period.institutionId,
        status: { in: GUEST_CONFIRMED },
        mealInstance: { serviceDate: serviceDateRange },
      },
    }),
    client.expense.aggregate({
      _sum: { totalMinor: true },
      where: { institutionId: period.institutionId, status: "APPROVED", date: { gte: bounds.startAt, lt: bounds.endExclusiveAt } },
    }),
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: period.institutionId,
        status: "APPROVED",
        submittedAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
  ]);
  const farPast = new Date(-864e13);
  const farFuture = new Date(864e13);
  const coveringResidents = residents.filter((r: any) => {
    const from = r.membershipEffectiveFrom ?? farPast;
    const until = r.membershipEffectiveUntil ?? farFuture;
    return from < bounds.endExclusiveAt && until >= bounds.startAt;
  });

  return {
    checks,
    ready: checks.every((c) => c.pass),
    variables,
    summary: {
      residentCount: coveringResidents.length,
      residentMealCount: mealCountAgg,
      guestMealCount: guestAgg._sum.quantity ?? 0,
      guestIncomeMinor: guestAgg._sum.totalPriceMinor ?? guestStored,
      eligibleExpensesMinor: expenseAgg._sum.totalMinor ?? 0,
      approvedPaymentsMinor: paymentAgg._sum.amountMinor ?? 0,
      mealChargeMinor,
      guestPriceMinor: inst?.settings.guestMealPriceMinor ?? 5500,
      formulaVersion: formulaVersion
        ? {
            version: formulaVersion.version,
            expressionSource: formulaVersion.expressionSource,
            humanPreview: formulaVersion.humanPreview,
          }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// GENERATION (spec §54-58)
// ---------------------------------------------------------------------------

export type GenerateResult = {
  period: { id: string; year: number; month: number; status: string };
  billCount: number;
  snapshotId: string;
  mealChargeMinor: number;
  guestPriceMinor: number;
  totalBilledMinor: number;
  totalDueMinor: number;
  totalPaymentsAppliedMinor: number;
  summaryText: string;
};

export async function generateBilling(
  periodId: string,
  adminUserId: string,
  requestId: string,
  arithmetic?: { a: number; b: number; answer: number },
  options?: { isSystemAuto?: boolean }
): Promise<GenerateResult> {
  const isAuto = Boolean(options?.isSystemAuto);

  // Human-confirmation arithmetic gate (stateless: the readiness endpoint issued
  // the challenge; the answer must match — spec §55). Skipped for automated system runs.
  if (!isAuto) {
    if (
      !arithmetic ||
      !Number.isInteger(arithmetic.a) ||
      !Number.isInteger(arithmetic.b) ||
      !Number.isInteger(arithmetic.answer) ||
      arithmetic.answer !== arithmetic.a + arithmetic.b
    ) {
      throw new ApiError(CODES.BILLING_CONFIRMATION_FAILED, "The confirmation answer was incorrect.", 422);
    }
  }

  const period = await db.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  const inst = await getInstitution(period.institutionId); // also pre-warms the cache for the tx below
  if (!inst) throw new ApiError(CODES.NOT_FOUND, "Institution not found.", 404);
  const tz = inst.timezone ?? "Asia/Kolkata";
  const bounds = periodBounds(period.year, period.month, tz);

  // Month-end check: manual or auto billing is strictly prohibited while the month is active
  if (!isMonthEnded(period.year, period.month, tz)) {
    throw new ApiError(
      CODES.BILLING_NOT_READY,
      `Bills can only be generated after the billing month has ended. Billing for ${monthLabel(period.year, period.month)} opens on ${new Intl.DateTimeFormat("en-IN", { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(bounds.endInstant)}.`,
      422
    );
  }

  return db.$transaction(async (tx: any) => {
    // Advisory-lock emulation: only one run may CLAIM generation. Status stays
    // OPEN during the run (readiness check 1 must still pass); generationState
    // guards concurrent runs and rolls back to null on any failure.
    const guard = await tx.billingPeriod.updateMany({
      where: { id: periodId, institutionId: period.institutionId, status: "OPEN", generationState: null },
      data: { generationState: "CLOSING" },
    });
    if (guard.count !== 1) {
      const current = await tx.billingPeriod.findUnique({ where: { id: periodId } });
      if (current?.status === "BILLED") {
        throw new ApiError(CODES.BILLING_ALREADY_BILLED, "This period has already been billed.", 409);
      }
      if (current?.generationState === "CLOSING" || current?.generationState === "GENERATING") {
        throw new ApiError(CODES.BILLING_PERIOD_CLOSED, "A billing run is already in progress for this period.", 409);
      }
      throw new ApiError(CODES.BILLING_PERIOD_CLOSED, "This period is not open for billing.", 409);
    }

    // Readiness re-run INSIDE the transaction — failures roll back to OPEN.
    const readiness = await computeReadiness(periodId, tx);
    if (!readiness.ready) {
      const failed = readiness.checks.filter((c) => !c.pass);
      const error = new ApiError(
        CODES.BILLING_NOT_READY,
        `This period isn't ready to bill: ${failed.map((f) => f.label).join("; ")}.`,
        422
      );
      (error as ApiError).fields = { checks: JSON.stringify(failed) };
      throw error;
    }

    const summary = readiness.summary;
    const mealChargeMinor = summary.mealChargeMinor as number;
    const guestPriceMinor = summary.guestPriceMinor;

    // ---- Gather every snapshot input (all reads inside the tx) ----
    // NOTE: User↔Profile relation is User.userProfileId (FK on User) — profiles
    // come along with the user query instead of a reverse relation filter.
    const [residentRows, mealRows, guestRows, expenseRows, paymentRows, refundRows, exemptionRows, formulaVersion] =
      await Promise.all([
        tx.user.findMany({
          where: { institutionId: period.institutionId, role: "RESIDENT", status: { in: ["ACTIVE", "INACTIVE", "PENDING_DELETION"] } },
          select: {
            id: true,
            email: true,
            membershipEffectiveFrom: true,
            membershipEffectiveUntil: true,
            profile: { select: { fullName: true, roomNumber: true } },
          },
        }),
        tx.residentMeal.findMany({
          where: confirmedResidentMealFilter(period.institutionId, { gte: bounds.startAt, lt: bounds.endExclusiveAt }),
          select: { residentId: true },
        }),
        tx.guestMealRequest.findMany({
          where: {
            institutionId: period.institutionId,
            status: { in: GUEST_CONFIRMED },
            mealInstance: { serviceDate: { gte: bounds.startAt, lt: bounds.endExclusiveAt } },
          },
          select: { hostResidentId: true, quantity: true, totalPriceMinor: true, unitPriceMinor: true },
        }),
        tx.expense.findMany({
          where: {
            institutionId: period.institutionId,
            status: "APPROVED",
            date: { gte: bounds.startAt, lt: bounds.endExclusiveAt },
          },
          select: { id: true, displayNumber: true, date: true, totalMinor: true, description: true },
          orderBy: { date: "asc" },
        }),
        tx.payment.findMany({
          where: {
            institutionId: period.institutionId,
            status: "APPROVED",
            submittedAt: { gte: bounds.startInstant, lt: bounds.endInstant },
          },
          select: { id: true, displayNumber: true, residentId: true, amountMinor: true, submittedAt: true },
          orderBy: { submittedAt: "asc" },
        }),
        tx.refund.findMany({
          where: { institutionId: period.institutionId, createdAt: { gte: bounds.startInstant, lt: bounds.endInstant } },
          select: { id: true, residentId: true, amountMinor: true, mode: true, status: true },
        }),
        tx.policyExemption.findMany({
          where: { institutionId: period.institutionId, policyType: "DEFICIT_RESTRICTION" },
          select: { id: true, residentId: true, reason: true, startsAt: true, expiresAt: true },
        }),
        resolveFormulaVersionForPeriod(period.institutionId, bounds.startAt, "meal_charge", tx),
      ]);

    const farPast = new Date(-864e13);
    const farFuture = new Date(864e13);
    const residents = (residentRows as any[])
      .filter((r: any) => {
        const from = r.membershipEffectiveFrom ?? farPast;
        const until = r.membershipEffectiveUntil ?? farFuture;
        return from < bounds.endExclusiveAt && until >= bounds.startAt;
      })
      .map((r: any) => ({
        id: r.id,
        email: r.email,
        fullName: r.profile?.fullName ?? "Resident",
        roomNumber: r.profile?.roomNumber ?? null,
      }));

    // Meal / guest / payment groupings per resident.
    const mealsByResident = new Map<string, number>();
    for (const row of mealRows as any[]) {
      mealsByResident.set(row.residentId, (mealsByResident.get(row.residentId) ?? 0) + 1);
    }
    const guestsByResident = new Map<string, { quantity: number; amountMinor: number }>();
    for (const g of guestRows as any[]) {
      const entry = guestsByResident.get(g.hostResidentId) ?? { quantity: 0, amountMinor: 0 };
      entry.quantity += g.quantity;
      entry.amountMinor += g.totalPriceMinor;
      guestsByResident.set(g.hostResidentId, entry);
    }
    const paymentsByResident = new Map<string, any[]>();
    for (const p of paymentRows as any[]) {
      const list = paymentsByResident.get(p.residentId) ?? [];
      list.push(p);
      paymentsByResident.set(p.residentId, list);
    }

    // Account credit is not scoped to the billed month. A resident may have
    // prepaid earlier or explicitly carried forward excess from the previous
    // bill. New bills must consume that existing approved credit immediately,
    // otherwise the bill can incorrectly show Due while Funds shows a positive
    // balance. Read all three authoritative components in one bounded batch.
    const [allApprovedCreditRows, priorBillRows, completedCashRefundRows] = await Promise.all([
      tx.payment.findMany({
        where: {
          institutionId: period.institutionId,
          status: "APPROVED",
        },
        select: { id: true, residentId: true, amountMinor: true },
      }),
      tx.bill.findMany({
        where: { institutionId: period.institutionId, status: { not: "VOIDED" } },
        select: { residentId: true, subtotalMinor: true, adjustmentsMinor: true },
      }),
      tx.refund.findMany({
        where: {
          institutionId: period.institutionId,
          status: "COMPLETED",
          mode: "ISSUE_REFUND",
        },
        select: { residentId: true, amountMinor: true },
      }),
    ]);

    const approvedCreditByResident = new Map<string, number>();
    for (const row of allApprovedCreditRows as any[]) {
      approvedCreditByResident.set(
        row.residentId,
        (approvedCreditByResident.get(row.residentId) ?? 0) + row.amountMinor
      );
    }
    const priorChargesByResident = new Map<string, number>();
    for (const row of priorBillRows as any[]) {
      const effectiveCharge = Math.max(0, row.subtotalMinor + row.adjustmentsMinor);
      priorChargesByResident.set(
        row.residentId,
        (priorChargesByResident.get(row.residentId) ?? 0) + effectiveCharge
      );
    }
    const cashRefundsByResident = new Map<string, number>();
    for (const row of completedCashRefundRows as any[]) {
      cashRefundsByResident.set(
        row.residentId,
        (cashRefundsByResident.get(row.residentId) ?? 0) + row.amountMinor
      );
    }
    const accountCreditBeforeBillByResident = new Map<string, number>();
    for (const resident of residents) {
      const approved = approvedCreditByResident.get(resident.id) ?? 0;
      const priorCharges = priorChargesByResident.get(resident.id) ?? 0;
      const cashRefunds = cashRefundsByResident.get(resident.id) ?? 0;
      accountCreditBeforeBillByResident.set(
        resident.id,
        Math.max(0, approved - priorCharges - cashRefunds)
      );
    }

    // ---- Immutable snapshot ----
    const ast = JSON.parse(formulaVersion.compiledAstJson) as FormulaAst;
    const payload = {
      period: { year: period.year, month: period.month, startKey: bounds.startKey, endKey: bounds.endKey },
      generatedAt: new Date().toISOString(),
      institution: {
        id: inst.id,
        name: inst.name,
        timezone: inst.timezone,
        currencyCode: inst.currencyCode,
      },
      settings: inst.settings,
      formula: {
        versionId: formulaVersion.id,
        version: formulaVersion.version,
        inputMode: formulaVersion.inputMode,
        expressionSource: formulaVersion.expressionSource,
        naturalSource: formulaVersion.naturalSource ?? null,
        humanPreview: formulaVersion.humanPreview,
        ast,
        checksum: formulaVersion.checksum,
      },
      variables: readiness.variables,
      mealChargeMinor,
      guestPriceMinor,
      residents: residents.map((r) => {
        const guest = guestsByResident.get(r.id) ?? { quantity: 0, amountMinor: 0 };
        return {
          id: r.id,
          fullName: r.fullName,
          email: r.email,
          roomNumber: r.roomNumber,
          mealsOn: mealsByResident.get(r.id) ?? 0,
          guestQuantity: guest.quantity,
          guestAmountMinor: guest.amountMinor,
          approvedPaymentsMinor: (paymentsByResident.get(r.id) ?? []).reduce((s, p) => s + p.amountMinor, 0),
          accountCreditBeforeBillMinor: accountCreditBeforeBillByResident.get(r.id) ?? 0,
        };
      }),
      eligibleExpenses: expenseRows,
      approvedPayments: paymentRows.map((p: any) => ({ ...p, submittedAt: p.submittedAt.toISOString() })),
      refunds: refundRows,
      policyExemptions: exemptionRows.map((e: any) => ({
        ...e,
        startsAt: e.startsAt.toISOString(),
        expiresAt: e.expiresAt.toISOString(),
      })),
      totals: {
        residentCount: residents.length,
        residentMealCount: summary.residentMealCount,
        guestMealCount: summary.guestMealCount,
        eligibleExpensesMinor: summary.eligibleExpensesMinor,
        approvedPaymentsMinor: summary.approvedPaymentsMinor,
      },
    };
    const payloadJson = JSON.stringify(payload);
    const checksum = billingSnapshotChecksum(payloadJson);

    const snapshot = await tx.billingSnapshot.create({
      data: {
        institutionId: period.institutionId,
        billingPeriodId: periodId,
        payloadJson,
        checksum,
        residentCount: residents.length,
        residentMealCount: summary.residentMealCount,
        guestMealCount: summary.guestMealCount,
        eligibleExpensesMinor: summary.eligibleExpensesMinor,
        approvedPaymentsMinor: summary.approvedPaymentsMinor,
        mealChargeMinor,
        createdByUserId: adminUserId,
      },
    });

    // Reserve the entire billing run's globally unique number range atomically
    // inside the same transaction. Concurrent institutions billing the same
    // month therefore cannot receive overlapping BILL-YYYYMM sequences.
    const billNumbers = await nextBillNumbers(period.year, period.month, residents.length, tx);
    const dueDate = localDateMidnightUtc(addDaysToKey(bounds.endKey, inst.settings.billingDueDays));
    const formulaDetail = {
      period: { year: period.year, month: period.month, startKey: bounds.startKey, endKey: bounds.endKey },
      snapshot: { id: snapshot.id, checksum },
      formula: {
        versionId: formulaVersion.id,
        version: formulaVersion.version,
        checksum: formulaVersion.checksum,
        expressionSource: formulaVersion.expressionSource,
        humanPreview: formulaVersion.humanPreview,
      },
    };
    const label = monthLabel(period.year, period.month);

    let totalBilledMinor = 0;
    let totalDueMinor = 0;
    let totalPaymentsAppliedMinor = 0;

    for (let i = 0; i < residents.length; i += 1) {
      const resident = residents[i];
      const mealCount = mealsByResident.get(resident.id) ?? 0;
      const guest = guestsByResident.get(resident.id) ?? { quantity: 0, amountMinor: 0 };
      const mealAmount = multiplyRoundHalfUp(mealCount, mealChargeMinor);
      // Bill guests at the price CONFIRMED AT BOOKING (each request froze its
      // unit price — fixed-price instances may differ from today's settings),
      // never at the current settings price (audit 9-a #2 / 9-b #1).
      const guestAmount = guest.amountMinor;
      const guestUnitAverage = guest.quantity > 0 ? Math.round(guestAmount / guest.quantity) : guestPriceMinor;
      const subtotal = mealAmount + guestAmount;
      const myPayments = paymentsByResident.get(resident.id) ?? [];
      const periodApprovedTotal = myPayments.reduce((s, p) => s + p.amountMinor, 0);
      const accountCreditBeforeBill = accountCreditBeforeBillByResident.get(resident.id) ?? 0;
      const paymentsApplied = Math.min(subtotal, accountCreditBeforeBill);
      const totalDue = Math.max(0, subtotal - paymentsApplied);

      const lines: { code: string; label: string; quantity?: number; unitPriceMinor?: number; amountMinor: number; detailJson?: string; sortOrder: number }[] = [];
      if (mealCount > 0) {
        lines.push({
          code: "RESIDENT_MEALS",
          label: `Resident meals — ${mealCount} × ${formatMinor(mealChargeMinor)}`,
          quantity: mealCount,
          unitPriceMinor: mealChargeMinor,
          amountMinor: mealAmount,
          detailJson: JSON.stringify({
            ...formulaDetail,
            unitPriceMinor: mealChargeMinor,
            priceSource: "formula",
          }),
          sortOrder: 1,
        });
      }
      if (guest.quantity > 0) {
        lines.push({
          code: "GUEST_MEALS",
          label: `Guest meals — ${guest.quantity} × ${formatMinor(guestUnitAverage)} (as booked)`,
          quantity: guest.quantity,
          unitPriceMinor: guestUnitAverage,
          amountMinor: guestAmount,
          detailJson: JSON.stringify({
            ...formulaDetail,
            unitPriceMinor: guestUnitAverage,
            priceSource: "confirmed guest meal requests (price frozen at booking)",
          }),
          sortOrder: 2,
        });
      }
      if (paymentsApplied > 0) {
        lines.push({
          code: "PAYMENTS_APPLIED",
          label: "Payments applied",
          amountMinor: -paymentsApplied,
          detailJson: JSON.stringify({
            policy:
              "All approved resident account credit available at bill generation, after prior non-voided charges and completed cash refunds, capped at the subtotal.",
            accountCreditBeforeBillMinor: accountCreditBeforeBill,
            periodApprovedPaymentsMinor: periodApprovedTotal,
            periodPaymentCount: myPayments.length,
            periodPaymentIds: myPayments.slice(0, 50).map((p) => p.id),
          }),
          sortOrder: 3,
        });
      }

      const bill = await tx.bill.create({
        data: {
          institutionId: period.institutionId,
          residentId: resident.id,
          billingPeriodId: periodId,
          snapshotId: snapshot.id,
          billNumber: billNumbers[i],
          revision: 1,
          residentMealCount: mealCount,
          guestMealCount: guest.quantity,
          mealChargeMinor,
          guestChargeMinor: guestAmount,
          subtotalMinor: subtotal,
          adjustmentsMinor: 0,
          paymentsMinor: paymentsApplied,
          totalDueMinor: totalDue,
          dueDate,
          status: totalDue === 0 ? "PAID" : "GENERATED",
          lines: { create: lines },
        },
      });

      // Double-entry: Dr RESIDENT_FUNDS (subtotal) / Cr income accounts (split).
      // (The link lives on the ledger side: journal refType "BILL" + refId = bill id.
      //  The Bill model intentionally carries no journal column — snapshot + ledger
      //  are the source of truth; the schema is frozen.)
      if (subtotal > 0) {
        const journalLines: JournalLine[] = [
          { accountCode: "RESIDENT_FUNDS", debitMinor: subtotal },
          { accountCode: "MEAL_CHARGE_INCOME", creditMinor: mealAmount },
          { accountCode: "GUEST_INCOME", creditMinor: guestAmount },
        ];
        await postJournal(
          {
            institutionId: period.institutionId,
            description: `Bill ${bill.billNumber} — ${resident.fullName} (${label})`,
            refType: "BILL",
            refId: bill.id,
            createdByUserId: adminUserId,
            lines: journalLines,
          },
          tx
        );
      }

      totalBilledMinor += subtotal;
      totalDueMinor += totalDue;
      totalPaymentsAppliedMinor += paymentsApplied;

      await appendOutbox(
        period.institutionId,
        "NOTIFICATION",
        {
          userId: resident.id,
          institutionId: period.institutionId,
          type: "BILL_GENERATED",
          title: "Bill generated",
          message: `Your ${label} bill has been generated — ${formatMinor(totalDue)}`,
          entityRef: bill.id,
        },
        tx
      );
    }

    const now = new Date();
    const billedPeriod = await tx.billingPeriod.update({
      where: { id: periodId },
      data: {
        status: "BILLED",
        billedAt: now,
        closedAt: now,
        mealChargeMinorSnapshot: mealChargeMinor,
        guestPriceMinorSnapshot: guestPriceMinor,
        formulaVersionId: formulaVersion.id,
        generationState: "COMPLETED",
        generationError: null,
      },
    });

    await appendAudit(
      {
        institutionId: period.institutionId,
        actorUserId: isAuto ? (adminUserId || "SYSTEM") : adminUserId,
        actorRole: isAuto ? "SYSTEM" : "ADMIN",
        action: isAuto ? "BILLING_AUTO_GENERATED" : "BILLING_GENERATED",
        entityType: "BILLING_PERIOD",
        entityId: periodId,
        requestId,
        beforeSummary: "OPEN",
        afterSummary: "BILLED",
        metadata: {
          period: { year: period.year, month: period.month },
          autoGenerated: isAuto,
          billCount: residents.length,
          residentCount: residents.length,
          residentMealCount: summary.residentMealCount,
          guestMealCount: summary.guestMealCount,
          totalBilledMinor,
          totalDueMinor,
          totalPaymentsAppliedMinor,
          mealChargeMinor,
          guestPriceMinor,
          formulaVersion: formulaVersion.version,
          snapshotId: snapshot.id,
        },
      },
      tx
    );

    return {
      period: {
        id: billedPeriod.id,
        year: billedPeriod.year,
        month: billedPeriod.month,
        status: billedPeriod.status,
      },
      billCount: residents.length,
      snapshotId: snapshot.id,
      mealChargeMinor,
      guestPriceMinor,
      totalBilledMinor,
      totalDueMinor,
      totalPaymentsAppliedMinor,
      summaryText: `Bills for ${label} were generated for ${residents.length} resident${
        residents.length === 1 ? "" : "s"
      }. Per-meal charge ${formatMinor(mealChargeMinor)}, total billed ${formatMinor(totalBilledMinor)}, of which ${formatMinor(
        totalPaymentsAppliedMinor
      )} was covered by approved payments.`,
    };
  });
}

// ---------------------------------------------------------------------------
// REOPEN (spec §231, §59 — restricted, audit-only in v1)
// ---------------------------------------------------------------------------

export async function reopenBillingPeriod(
  periodId: string,
  adminUserId: string,
  requestId: string,
  reason: string
): Promise<{ period: any; note: string }> {
  const period = await db.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  if (period.status !== "BILLED") {
    throw new ApiError(
      CODES.BILLING_PERIOD_CLOSED,
      period.status === "REOPENED"
        ? "This period was already reopened."
        : "Only billed periods can be reopened.",
      409
    );
  }
  const billedAt = period.billedAt ?? period.closedAt ?? period.createdAt;
  if (Date.now() - billedAt.getTime() > 48 * 60 * 60 * 1000) {
    throw new ApiError(
      CODES.BILLING_PERIOD_CLOSED,
      "Reopen is only available within 48 hours of billing. Use bill adjustments to correct this period.",
      409
    );
  }

  return db.$transaction(async (tx: any) => {
    const guard = await tx.billingPeriod.updateMany({
      where: { id: periodId, status: "BILLED" },
      data: { status: "REOPENED", generationState: null },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.BILLING_PERIOD_CLOSED, "This period is no longer in a reopenable state.", 409);
    }
    const updated = await tx.billingPeriod.findUniqueOrThrow({ where: { id: periodId } });
    await appendAudit(
      {
        institutionId: period.institutionId,
        actorUserId: adminUserId,
        actorRole: "ADMIN",
        action: "BILLING_REOPENED",
        entityType: "BILLING_PERIOD",
        entityId: periodId,
        requestId,
        reason,
        beforeSummary: "BILLED",
        afterSummary: "REOPENED",
        metadata: { billedAt: billedAt.toISOString(), billsRemain: true },
      },
      tx
    );
    return {
      period: {
        id: updated.id,
        year: updated.year,
        month: updated.month,
        status: updated.status,
        billedAt: billedAt.toISOString(),
      },
      note:
        "This period is marked as reopened for audit. The generated bills remain authoritative — correct them with bill adjustments only (spec §59).",
    };
  });
}

/** Convenience for resident views: latest unsettled/overdue derivation. */
export function derivePaymentStatus(
  bills: { status: string; dueDate: Date }[],
  timeZone = "Asia/Kolkata",
  now = new Date()
): string {
  const unsettled = bills.filter((b) => UNSETTLED_BILL_STATUSES.includes(b.status));
  if (unsettled.some((b) => isBillPastDueDate(b.dueDate, timeZone, now))) return "Overdue";
  if (unsettled.length > 0) return "Due";
  return "Settled";
}

// ---------------------------------------------------------------------------
// LEGACY DESTRUCTIVE RESET — intentionally disabled
// ---------------------------------------------------------------------------

/**
 * Kept only as a compatibility symbol for any older internal caller. Posted
 * billing journals and generated historical artifacts are immutable: correction
 * must use reopen + bill adjustments / reversal journals, never physical delete.
 */
export async function removePeriodBills(
  periodId: string,
  actorUserId = "SYSTEM"
): Promise<{ removedCount: number; periodId: string }> {
  void actorUserId;
  const period = await db.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  throw new ApiError(
    CODES.BILLING_PERIOD_CLOSED,
    "Destructive billing reset is disabled. Generated bills, snapshots, and posted journals are immutable; use reopen plus audited bill adjustments or reversal journals for corrections.",
    409
  );
}

// ---------------------------------------------------------------------------
// AUTOMATIC BILL GENERATION (Runs on 5th day of next month)
// ---------------------------------------------------------------------------

/**
 * Scans for OPEN billing periods that are due for automatic generation
 * (i.e. local date is on or after the 5th day of the month following the period).
 * Generates bills for any period whose readiness checks pass.
 */
export async function autoGenerateDuePeriods(institutionId?: string): Promise<{
  generated: { periodId: string; periodKey: string; billCount: number }[];
  skipped: { periodId: string; periodKey: string; reason: string }[];
}> {
  const now = new Date();
  const where: any = { status: "OPEN" };
  if (institutionId) where.institutionId = institutionId;

  const openPeriods = await db.billingPeriod.findMany({
    where,
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });

  const generated: { periodId: string; periodKey: string; billCount: number }[] = [];
  const skipped: { periodId: string; periodKey: string; reason: string }[] = [];

  for (const period of openPeriods) {
    const inst = await getInstitution(period.institutionId);
    const tz = inst?.timezone ?? "Asia/Kolkata";
    const periodKey = `${period.year}-${String(period.month).padStart(2, "0")}`;

    // 1. Check if auto-billing is due (on or after 5th day of the next month)
    if (!isAutoBillingDue(period.year, period.month, tz, now)) {
      skipped.push({ periodId: period.id, periodKey, reason: "Auto-billing not due yet (due on 5th of next month)" });
      continue;
    }

    // 2. Check readiness
    try {
      const readiness = await computeReadiness(period.id);
      if (!readiness.ready) {
        const failed = readiness.checks.filter((c) => !c.pass).map((c) => c.label).join("; ");
        skipped.push({ periodId: period.id, periodKey, reason: `Readiness check failed: ${failed}` });
        continue;
      }

      // 3. Generate billing as SYSTEM
      const res = await generateBilling(
        period.id,
        "SYSTEM",
        `auto_${period.year}_${period.month}_${Date.now()}`,
        undefined,
        { isSystemAuto: true }
      );

      generated.push({ periodId: period.id, periodKey, billCount: res.billCount });
    } catch (err: any) {
      skipped.push({ periodId: period.id, periodKey, reason: err?.message ?? "Auto-generation error" });
    }
  }

  return { generated, skipped };
}
