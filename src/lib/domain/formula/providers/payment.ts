/**
 * PAYMENT VARIABLE PROVIDER (spec §13)
 * Authoritative financial payment values.
 */
import { PeriodBounds } from "../period-variables";

export async function resolvePaymentVariables(
  institutionId: string,
  bounds: PeriodBounds,
  client: any
): Promise<Record<string, number>> {
  const timeRange = { gte: bounds.startInstant, lt: bounds.endInstant };
  const residentFundsAccount = await client.ledgerAccount.findFirst({
    where: { institutionId, code: "RESIDENT_FUNDS" },
    select: { id: true },
  });

  const [submittedAgg, approvedAgg, pendingAgg, refundsAgg, creditsAgg] = await Promise.all([
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, submittedAt: timeRange },
    }),
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: "APPROVED", submittedAt: timeRange },
    }),
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: { in: ["PENDING", "SUBMITTED"] }, submittedAt: timeRange },
    }),
    client.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId,
        status: "COMPLETED",
        mode: "ISSUE_REFUND",
        createdAt: timeRange,
      },
    }),
    residentFundsAccount
      ? client.ledgerEntry.aggregate({
          _sum: { creditMinor: true },
          where: {
            accountId: residentFundsAccount.id,
            journal: { institutionId, status: "POSTED", createdAt: timeRange },
          },
        })
      : Promise.resolve({ _sum: { creditMinor: 0 } }),
  ]);

  const approved = approvedAgg._sum.amountMinor ?? 0;

  return {
    total_payments_submitted: submittedAgg._sum.amountMinor ?? 0,
    total_payments_approved: approved,
    total_payments_pending: pendingAgg._sum.amountMinor ?? 0,
    // BoardOps currently has no separate payment-purpose field: every approved
    // resident receipt is a resident deposit, regardless of UPI/CASH/BANK/OTHER method.
    total_deposits: approved,
    // Carry-forward is a credit decision, not a cash payout.
    total_refunds: refundsAgg._sum.amountMinor ?? 0,
    // Resident-account credits only; do not sum credit entries from income/cash accounts.
    total_credits: creditsAgg._sum.creditMinor ?? 0,
    total_collected: approved,
  };
}
