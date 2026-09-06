/**
 * FUNDS VARIABLE PROVIDER (spec §14)
 * Resolves available funds, deficits, credit balances, and outstanding balances.
 */
import { getAccountBalances } from "@/lib/domain/ledger";

export async function resolveFundsVariables(
  institutionId: string,
  client: any
): Promise<Record<string, number>> {
  const [activeResidents, accounts, settings] = await Promise.all([
    client.user.findMany({
      where: { institutionId, role: "RESIDENT", status: "ACTIVE" },
      select: { id: true },
      take: 200,
    }),
    getAccountBalances(institutionId).catch(() => []),
    client.institutionSettings.findUnique({
      where: { institutionId },
      select: { deficitThresholdMinor: true, gracePeriodDays: true },
    }),
  ]);

  const cashAccount = accounts.find((a: any) => a.code === "CASH");
  const cashBalance = cashAccount ? cashAccount.balanceMinor : 0;

  // Aggregate resident balances
  const [paymentsAgg, billsAgg, refundsAgg] = await Promise.all([
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: "APPROVED" },
    }),
    client.bill.aggregate({
      _sum: { subtotalMinor: true, adjustmentsMinor: true, totalDueMinor: true },
      where: { institutionId, status: { not: "VOIDED" } },
    }),
    client.refund.aggregate({
      _sum: { amountMinor: true },
      where: { institutionId, status: "COMPLETED", mode: "ISSUE_REFUND" },
    }),
  ]);

  const totalCredits = paymentsAgg._sum.amountMinor ?? 0;
  const totalCharges = (billsAgg._sum.subtotalMinor ?? 0) + (billsAgg._sum.adjustmentsMinor ?? 0);
  const totalRefunds = refundsAgg._sum.amountMinor ?? 0;
  const totalOutstanding = billsAgg._sum.totalDueMinor ?? 0;

  const netResidentFunds = totalCredits - totalCharges - totalRefunds;
  const availableFunds = Math.max(0, cashBalance > 0 ? cashBalance : netResidentFunds);
  const totalDeficit = netResidentFunds < 0 ? Math.abs(netResidentFunds) : 0;
  const totalCreditBalance = netResidentFunds > 0 ? netResidentFunds : 0;
  const remainingFunds = Math.max(0, availableFunds - totalOutstanding);

  return {
    available_funds: availableFunds,
    remaining_funds: remainingFunds,
    total_deficit: totalDeficit,
    total_credit_balance: totalCreditBalance,
    total_outstanding_balance: totalOutstanding,
    deficit_threshold: settings?.deficitThresholdMinor ?? 100000,
    grace_period_days: settings?.gracePeriodDays ?? 7,
  };
}
