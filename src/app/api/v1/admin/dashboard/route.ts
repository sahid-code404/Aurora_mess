/**
 * GET /api/v1/admin/dashboard — the admin home view (auth ADMIN, spec §205-210):
 * institution-local greeting; KPIs (active residents, meals confirmed today,
 * available institution cash, current per-meal charge estimate — null-safe);
 * "needs attention" queue (ONLY actionable counts, each linking to its view);
 * recent activity = the last 12 audit events with human copy.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { formatMinor } from "@/lib/money";
import { dateKeyInTz, greetingFor, localDateMidnightUtc, partsInTz } from "@/lib/time";
import { describeAuditEvent } from "@/lib/domain/activity";
import { getAccountBalances } from "@/lib/domain/ledger";
import { institutionResidentFinancialTotals } from "@/lib/domain/institution-financial-totals";
import { currentPeriodBounds, gatherPeriodVariables } from "@/lib/domain/formula/period-variables";
import { resolveFormulaVersionForPeriod } from "@/lib/domain/formula/versions";
import { FormulaAst } from "@/lib/domain/formula/ast";
import { evaluateFormula } from "@/lib/domain/formula/evaluator";
import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const now = new Date();
  const parts = partsInTz(now, tz);
  const greeting = greetingFor(parts.hour);
  const todayMidnight = localDateMidnightUtc(dateKeyInTz(now, tz));
  const bounds = currentPeriodBounds(tz);

  sweepOutbox(30).catch(() => {});

  const [
    activeResidentCount,
    mealsToday,
    guestsTodayAgg,
    pendingResidentApprovals,
    pendingPayments,
    pendingLeaveRequests,
    submittedTaskSubmissions,
    pendingExpenses,
    recentAudit,
  ] = await Promise.all([
    db.user.count({ where: { institutionId: ctx.institutionId, role: "RESIDENT", status: "ACTIVE" } }),
    db.residentMeal.count({
      where: {
        institutionId: ctx.institutionId,
        effectiveState: "ON",
        mealInstance: { serviceDate: todayMidnight },
      },
    }),
    // Today's GUEST meals (non-cancelled) — per-time totals include guests
    // (e.g. lunch 3 regular + 1 guest = 4 total), while month totals never do.
    db.guestMealRequest.aggregate({
      where: {
        institutionId: ctx.institutionId,
        status: { not: "CANCELLED" },
        mealInstance: { serviceDate: todayMidnight },
      },
      _sum: { quantity: true },
    }),
    db.user.count({ where: { institutionId: ctx.institutionId, status: "PENDING_APPROVAL" } }),
    db.payment.count({ where: { institutionId: ctx.institutionId, status: "PENDING" } }),
    db.leaveRequest.count({ where: { institutionId: ctx.institutionId, status: "PENDING" } }),
    db.taskSubmission.count({
      where: { status: "SUBMITTED", task: { institutionId: ctx.institutionId } },
    }),
    db.expense.count({ where: { institutionId: ctx.institutionId, status: "PENDING" } }),
    db.auditEvent.findMany({
      where: { institutionId: ctx.institutionId },
      orderBy: { occurredAt: "desc" },
      take: 12,
    }),
  ]);

  const [variables, formulaVersion, accounts, residentTotals] = await Promise.all([
    gatherPeriodVariables(ctx.institutionId, bounds.year, bounds.month),
    resolveFormulaVersionForPeriod(ctx.institutionId, bounds.startAt),
    getAccountBalances(ctx.institutionId),
    institutionResidentFinancialTotals(ctx.institutionId),
  ]);
  const cashBalance = accounts.find((account) => account.code === "CASH")?.balanceMinor ?? 0;
  const availableFunds = Math.max(0, cashBalance);
  const cashDeficit = Math.max(0, -cashBalance);

  let mealCharge: number | null = null;
  if (formulaVersion) {
    try {
      const evaluated = evaluateFormula(JSON.parse(formulaVersion.compiledAstJson) as FormulaAst, variables);
      mealCharge = Number.isFinite(evaluated) ? evaluated : null;
    } catch {
      mealCharge = null; // divide-by-zero etc. → the dashboard shows "—"
    }
  }

  const needsAttention = [
    {
      key: "pendingResidentApprovals",
      label: "Resident approvals",
      count: pendingResidentApprovals,
      href: "#/admin/residents",
    },
    { key: "pendingPayments", label: "Payments to review", count: pendingPayments, href: "#/admin/payments" },
    { key: "pendingLeaveRequests", label: "Leave requests", count: pendingLeaveRequests, href: "#/admin/calendar" },
    {
      key: "submittedTaskSubmissions",
      label: "Task submissions to verify",
      count: submittedTaskSubmissions,
      href: "#/admin/tasks",
    },
    { key: "pendingExpenses", label: "Expenses to review", count: pendingExpenses, href: "#/admin/expenses" },
  ].filter((item) => item.count > 0)
   .sort((a, b) => b.count - a.count);

  return {
    data: {
      greeting: {
        text: `${greeting.text}`,
        icon: greeting.icon,
        institutionName: inst?.name ?? "Institution",
        localTime: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
      },
      kpis: {
        residents: activeResidentCount,
        mealsToday,
        /** Today's guests — per-time/day totals INCLUDE guests. */
        guestsToday: guestsTodayAgg._sum.quantity ?? 0,
        availableFunds,
        availableFundsFormatted: formatMinor(availableFunds),
        cashBalance,
        cashBalanceFormatted: formatMinor(cashBalance),
        cashDeficit,
        cashDeficitFormatted: formatMinor(cashDeficit),
        residentCreditLiability: residentTotals.residentCreditLiabilityMinor,
        residentCreditLiabilityFormatted: formatMinor(residentTotals.residentCreditLiabilityMinor),
        residentOutstanding: residentTotals.outstandingBillsMinor,
        residentOutstandingFormatted: formatMinor(residentTotals.outstandingBillsMinor),
        mealCharge,
        mealChargeFormatted: mealCharge === null ? null : formatMinor(mealCharge),
        period: { year: bounds.year, month: bounds.month },
      },
      needsAttention,
      recentActivity: recentAudit.map((e) => ({
        id: e.id,
        action: e.action,
        copy: describeAuditEvent(e),
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        actorRole: e.actorRole ?? null,
        occurredAt: e.occurredAt.toISOString(),
      })),
    },
  };
});
