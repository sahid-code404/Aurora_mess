/**
 * FUNDS VARIABLE PROVIDER (spec §14)
 * Resolves institution cash, resident credit liabilities, and outstanding balances.
 */
import { getAccountBalances } from "@/lib/domain/ledger";
import { institutionResidentFinancialTotals } from "@/lib/domain/institution-financial-totals";

export async function resolveFundsVariables(
  institutionId: string,
  client: any
): Promise<Record<string, number>> {
  const [accounts, settings, residentTotals] = await Promise.all([
    getAccountBalances(institutionId, client),
    client.institutionSettings.findUnique({
      where: { institutionId },
      select: { deficitThresholdMinor: true, gracePeriodDays: true },
    }),
    institutionResidentFinancialTotals(institutionId, client),
  ]);

  const cashAccount = accounts.find((a: any) => a.code === "CASH");
  const cashBalance = cashAccount?.balanceMinor ?? 0;

  // "Available" is liquid institution cash, not resident account credit.
  // A negative cash balance is surfaced separately as institutional deficit.
  const availableFunds = Math.max(0, cashBalance);
  const totalDeficit = Math.max(0, -cashBalance);

  return {
    available_funds: availableFunds,
    // Legacy alias: keep the same authoritative cash meaning rather than
    // inventing a second balance by subtracting resident receivables.
    remaining_funds: availableFunds,
    total_deficit: totalDeficit,
    total_credit_balance: residentTotals.residentCreditLiabilityMinor,
    total_outstanding_balance: residentTotals.outstandingBillsMinor,
    deficit_threshold: settings?.deficitThresholdMinor ?? 100000,
    grace_period_days: settings?.gracePeriodDays ?? 7,
  };
}
