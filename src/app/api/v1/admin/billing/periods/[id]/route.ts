/**
 * GET /api/v1/admin/billing/periods/[id] — period detail (auth ADMIN):
 * the period row, immutable snapshot summary/provenance, integrity checks, and
 * generated bills with resident names.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { monthLabel } from "@/lib/domain/billing";
import { verifyBillingPeriodIntegrity } from "@/lib/domain/billing-integrity";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const period = await db.billingPeriod.findUnique({
    where: { id: ctx.params.id },
  });
  if (!period || period.institutionId !== ctx.institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  }

  const [snapshot, bills, integrity] = await Promise.all([
    db.billingSnapshot.findUnique({ where: { billingPeriodId: period.id } }),
    db.bill.findMany({
      where: { billingPeriodId: period.id },
      orderBy: { billNumber: "asc" },
      include: { period: { select: { id: true, year: true, month: true, status: true } } },
    }),
    verifyBillingPeriodIntegrity(period.id),
  ]);

  const residentIds = [...new Set(bills.map((bill) => bill.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({ where: { userId: { in: residentIds } }, select: { userId: true, fullName: true } })
    : [];
  const nameMap = new Map(profiles.map((profile) => [profile.userId, profile.fullName]));

  let snapshotSummary: Record<string, unknown> | null = null;
  if (snapshot) {
    let formula: Record<string, unknown> | null = null;
    let guestIncomeMinor = 0;
    try {
      const payload = JSON.parse(snapshot.payloadJson);
      formula = payload?.formula ?? null;
      if (typeof payload?.variables?.guest_income === "number") {
        guestIncomeMinor = payload.variables.guest_income;
      } else if (typeof payload?.guestIncomeMinor === "number") {
        guestIncomeMinor = payload.guestIncomeMinor;
      } else if (Array.isArray(payload?.residents)) {
        guestIncomeMinor = payload.residents.reduce(
          (sum: number, resident: any) => sum + (Number(resident.guestAmountMinor) || 0),
          0
        );
      }
    } catch {
      formula = null;
    }
    snapshotSummary = {
      id: snapshot.id,
      checksum: snapshot.checksum,
      createdAt: snapshot.createdAt.toISOString(),
      residentCount: snapshot.residentCount,
      residentMealCount: snapshot.residentMealCount,
      guestMealCount: snapshot.guestMealCount,
      guestIncomeMinor,
      guestIncomeFormatted: formatMinor(guestIncomeMinor),
      eligibleExpensesMinor: snapshot.eligibleExpensesMinor,
      eligibleExpensesFormatted: formatMinor(snapshot.eligibleExpensesMinor),
      approvedPaymentsMinor: snapshot.approvedPaymentsMinor,
      approvedPaymentsFormatted: formatMinor(snapshot.approvedPaymentsMinor),
      mealChargeMinor: snapshot.mealChargeMinor,
      mealChargeFormatted: formatMinor(snapshot.mealChargeMinor),
      formula,
    };
  }

  return {
    data: {
      period: {
        id: period.id,
        year: period.year,
        month: period.month,
        monthLabel: monthLabel(period.year, period.month),
        status: period.status,
        generationState: period.generationState ?? null,
        billedAt: period.billedAt ? period.billedAt.toISOString() : null,
        closedAt: period.closedAt ? period.closedAt.toISOString() : null,
        mealChargeMinorSnapshot: period.mealChargeMinorSnapshot ?? null,
        guestPriceMinorSnapshot: period.guestPriceMinorSnapshot ?? null,
        formulaVersionId: period.formulaVersionId ?? null,
        createdAt: period.createdAt.toISOString(),
      },
      snapshot: snapshotSummary,
      integrity,
      bills: bills.map((bill) => ({
        id: bill.id,
        billNumber: bill.billNumber,
        residentId: bill.residentId,
        residentName: nameMap.get(bill.residentId) ?? "Resident",
        status: bill.status,
        residentMealCount: bill.residentMealCount,
        guestMealCount: bill.guestMealCount,
        subtotalMinor: bill.subtotalMinor,
        subtotalFormatted: formatMinor(bill.subtotalMinor),
        adjustmentsMinor: bill.adjustmentsMinor,
        paymentsMinor: bill.paymentsMinor,
        paymentsFormatted: formatMinor(bill.paymentsMinor),
        totalDueMinor: bill.totalDueMinor,
        totalDueFormatted: formatMinor(bill.totalDueMinor),
        dueDate: bill.dueDate.toISOString(),
        generatedAt: bill.generatedAt.toISOString(),
      })),
    },
  };
});
