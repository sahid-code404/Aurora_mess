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

  const [submittedAgg, approvedAgg, pendingAgg, depositsAgg, refundsAgg, carryForwardAgg, creditsAgg] = await Promise.all([
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
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: "APPROVED", method: "DEPOSIT", submittedAt: timeRange },
    }),
    client.refund.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: "COMPLETED", mode: "ISSUE_REFUND", createdAt: timeRange },
    }),
    client.refund.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: "COMPLETED", mode: "CARRY_FORWARD", createdAt: timeRange },
    }),
    client.ledgerEntry.aggregate({
      _sum: { creditMinor: true },
      where: {
        journal: { institutionId, status: "POSTED", createdAt: timeRange },
      },
    }),
  ]);

  const approved = approvedAgg._sum.amountMinor ?? 0;

  return {
    total_payments_submitted: submittedAgg._sum.amountMinor ?? 0,
    total_payments_approved: approved,
    total_payments_pending: pendingAgg._sum.amountMinor ?? 0,
    total_deposits: depositsAgg._sum.amountMinor ?? 0,
    total_refunds: refundsAgg._sum.amountMinor ?? 0,
    total_carry_forward: carryForwardAgg._sum.amountMinor ?? 0,
    total_credits: creditsAgg._sum.creditMinor ?? 0,
    total_collected: approved,
  };
}
