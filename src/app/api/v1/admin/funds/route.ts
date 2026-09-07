/**
 * GET /api/v1/admin/funds — per-resident funds summaries + institution money
 * view (auth ADMIN, spec §42-44): displayed ACTIVE resident funds, authoritative
 * institution cash, complete resident credit/deficit aggregates, ledger accounts,
 * and active deficit-policy exemptions.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { residentFundsSummary } from "@/lib/domain/funds";
import { getAccountBalances } from "@/lib/domain/ledger";
import { institutionResidentFinancialTotals } from "@/lib/domain/institution-financial-totals";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const month = url.searchParams.get("month") ?? undefined;
  let monthYear: { year: number; month: number } | null = null;
  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Months use the YYYY-MM format.", 400);
    } else {
      monthYear = { year: Number(m[1]), month: Number(m[2]) };
    }
  }

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = monthYear ? periodBounds(monthYear.year, monthYear.month, tz) : currentPeriodBounds(tz);

  // The resident table remains bounded for UI performance. Accounting KPIs below
  // are computed independently across the complete institution and are never capped.
  const residents = await db.user.findMany({
    where: { institutionId: ctx.institutionId, role: "RESIDENT", status: "ACTIVE" },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const profiles = await db.userProfile.findMany({
    where: { userId: { in: residents.map((r) => r.id) } },
    select: { userId: true, fullName: true, roomNumber: true },
  });
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));
  const summaries = await Promise.all(residents.map((r) => residentFundsSummary(r.id)));

  const [depositsAgg, accounts, exemptions, residentTotals, activeResidentCount] = await Promise.all([
    db.payment.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        status: "APPROVED",
        submittedAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    getAccountBalances(ctx.institutionId),
    db.policyExemption.findMany({
      where: {
        institutionId: ctx.institutionId,
        policyType: "DEFICIT_RESTRICTION",
        startsAt: { lte: new Date() },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    }),
    institutionResidentFinancialTotals(ctx.institutionId),
    db.user.count({ where: { institutionId: ctx.institutionId, role: "RESIDENT", status: "ACTIVE" } }),
  ]);

  const exemptionResidentIds = [...new Set(exemptions.map((e) => e.residentId))];
  const exemptionProfiles = exemptionResidentIds.length
    ? await db.userProfile.findMany({
        where: { userId: { in: exemptionResidentIds } },
        select: { userId: true, fullName: true },
      })
    : [];
  const exemptionNameMap = new Map(exemptionProfiles.map((p) => [p.userId, p.fullName]));

  const cashBalance = accounts.find((account) => account.code === "CASH")?.balanceMinor ?? 0;
  const availableFundsTotal = Math.max(0, cashBalance);
  const cashDeficit = Math.max(0, -cashBalance);
  const totalDeficit = residentTotals.residentDeficitMinor;
  const depositsThisMonth = depositsAgg._sum.amountMinor ?? 0;

  return {
    data: {
      residents: residents
        .map((r, i) => {
          const summary = summaries[i];
          return {
            residentId: r.id,
            fullName: profileMap.get(r.id)?.fullName ?? "Resident",
            roomNumber: profileMap.get(r.id)?.roomNumber ?? null,
            email: r.email,
            creditsMinor: summary.creditsMinor,
            creditsFormatted: formatMinor(summary.creditsMinor),
            pendingPaymentsMinor: summary.pendingPaymentsMinor,
            pendingPaymentsFormatted: formatMinor(summary.pendingPaymentsMinor),
            chargesMinor: summary.chargesMinor,
            chargesFormatted: formatMinor(summary.chargesMinor),
            refundsIssuedMinor: summary.refundsIssuedMinor,
            refundsIssuedFormatted: formatMinor(summary.refundsIssuedMinor),
            carryForwardMinor: summary.carryForwardMinor,
            carryForwardFormatted: formatMinor(summary.carryForwardMinor),
            availableMinor: summary.availableMinor,
            availableFormatted: formatMinor(summary.availableMinor),
            amountToPayMinor: summary.amountToPayMinor,
            amountToPayFormatted: formatMinor(summary.amountToPayMinor),
            deficitMinor: summary.deficitMinor,
            deficitFormatted: formatMinor(summary.deficitMinor),
            policyState: summary.policyState,
            graceUntilIso: summary.graceUntilIso,
            thresholdMinor: summary.thresholdMinor,
          };
        })
        .sort((a, b) => {
          const rA = a.deficitMinor > 0 ? 0 : 1;
          const rB = b.deficitMinor > 0 ? 0 : 1;
          if (rA !== rB) return rA - rB;
          if (rA === 0) return b.deficitMinor - a.deficitMinor;
          return a.availableMinor - b.availableMinor;
        }),
      kpis: {
        month: bounds.key,
        depositsThisMonth,
        depositsThisMonthFormatted: formatMinor(depositsThisMonth),
        availableFundsTotal,
        availableFundsTotalFormatted: formatMinor(availableFundsTotal),
        cashBalance,
        cashBalanceFormatted: formatMinor(cashBalance),
        cashDeficit,
        cashDeficitFormatted: formatMinor(cashDeficit),
        residentCreditLiability: residentTotals.residentCreditLiabilityMinor,
        residentCreditLiabilityFormatted: formatMinor(residentTotals.residentCreditLiabilityMinor),
        totalOutstanding: residentTotals.outstandingBillsMinor,
        totalOutstandingFormatted: formatMinor(residentTotals.outstandingBillsMinor),
        totalDeficit,
        totalDeficitFormatted: formatMinor(totalDeficit),
        residentCount: activeResidentCount,
      },
      accounts: accounts.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
        debitMinor: a.debitMinor,
        creditMinor: a.creditMinor,
        balanceMinor: a.balanceMinor,
        balanceFormatted: formatMinor(a.balanceMinor),
      })),
      policyExemptions: exemptions.map((e) => ({
        id: e.id,
        residentId: e.residentId,
        residentName: exemptionNameMap.get(e.residentId) ?? "Resident",
        policyType: e.policyType,
        reason: e.reason,
        startsAt: e.startsAt.toISOString(),
        expiresAt: e.expiresAt.toISOString(),
        approvedByUserId: e.approvedByUserId,
      })),
    },
    meta: {
      month: bounds.key,
      residentRowsLimited: activeResidentCount > residents.length,
      residentRowsReturned: residents.length,
    },
  };
});
