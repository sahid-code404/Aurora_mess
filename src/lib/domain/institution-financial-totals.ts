import { db } from "@/lib/db";

export type InstitutionResidentFinancialTotals = {
  approvedPaymentsMinor: number;
  effectiveChargesMinor: number;
  completedCashRefundsMinor: number;
  residentCreditLiabilityMinor: number;
  residentDeficitMinor: number;
  outstandingBillsMinor: number;
  netResidentFundsMinor: number;
};

type PaymentGroup = { residentId: string; _sum: { amountMinor: number | null } };
type BillGroup = {
  residentId: string;
  _sum: {
    subtotalMinor: number | null;
    adjustmentsMinor: number | null;
    totalDueMinor: number | null;
  };
};
type RefundGroup = { residentId: string; _sum: { amountMinor: number | null } };

/**
 * Institution-wide resident financial position without cross-resident netting.
 *
 * A resident with +₹500 credit and another with ₹500 outstanding must remain
 * ₹500 liability + ₹500 deficit; those positions never cancel each other.
 * Inactive/departed residents remain included while financial records exist.
 */
export function summarizeResidentFinancialGroups(
  paymentGroups: PaymentGroup[],
  billGroups: BillGroup[],
  refundGroups: RefundGroup[]
): InstitutionResidentFinancialTotals {
  const ids = new Set<string>();
  const approved = new Map<string, number>();
  const charges = new Map<string, number>();
  const refunds = new Map<string, number>();
  let outstandingBillsMinor = 0;

  for (const row of paymentGroups) {
    ids.add(row.residentId);
    approved.set(row.residentId, row._sum.amountMinor ?? 0);
  }

  for (const row of billGroups) {
    ids.add(row.residentId);
    const subtotal = row._sum.subtotalMinor ?? 0;
    const adjustments = row._sum.adjustmentsMinor ?? 0;
    charges.set(row.residentId, Math.max(0, subtotal + adjustments));
    outstandingBillsMinor += row._sum.totalDueMinor ?? 0;
  }

  for (const row of refundGroups) {
    ids.add(row.residentId);
    refunds.set(row.residentId, row._sum.amountMinor ?? 0);
  }

  let approvedPaymentsMinor = 0;
  let effectiveChargesMinor = 0;
  let completedCashRefundsMinor = 0;
  let residentCreditLiabilityMinor = 0;
  let residentDeficitMinor = 0;

  for (const residentId of ids) {
    const residentApproved = approved.get(residentId) ?? 0;
    const residentCharges = charges.get(residentId) ?? 0;
    const residentRefunds = refunds.get(residentId) ?? 0;
    const net = residentApproved - residentCharges - residentRefunds;

    approvedPaymentsMinor += residentApproved;
    effectiveChargesMinor += residentCharges;
    completedCashRefundsMinor += residentRefunds;
    residentCreditLiabilityMinor += Math.max(0, net);
    residentDeficitMinor += Math.max(0, -net);
  }

  return {
    approvedPaymentsMinor,
    effectiveChargesMinor,
    completedCashRefundsMinor,
    residentCreditLiabilityMinor,
    residentDeficitMinor,
    outstandingBillsMinor,
    netResidentFundsMinor: approvedPaymentsMinor - effectiveChargesMinor - completedCashRefundsMinor,
  };
}

/**
 * Aggregate authoritative resident financial positions for the whole institution.
 * Uses grouped database reads, so accounting totals are never truncated by UI
 * pagination or the legacy 200-resident display cap.
 */
export async function institutionResidentFinancialTotals(
  institutionId: string,
  client: any = db
): Promise<InstitutionResidentFinancialTotals> {
  const [paymentGroups, billGroups, refundGroups] = await Promise.all([
    client.payment.groupBy({
      by: ["residentId"],
      where: { institutionId, status: "APPROVED" },
      _sum: { amountMinor: true },
    }),
    client.bill.groupBy({
      by: ["residentId"],
      where: { institutionId, status: { not: "VOIDED" } },
      _sum: { subtotalMinor: true, adjustmentsMinor: true, totalDueMinor: true },
    }),
    client.refund.groupBy({
      by: ["residentId"],
      where: { institutionId, status: "COMPLETED", mode: "ISSUE_REFUND" },
      _sum: { amountMinor: true },
    }),
  ]);

  return summarizeResidentFinancialGroups(paymentGroups, billGroups, refundGroups);
}
