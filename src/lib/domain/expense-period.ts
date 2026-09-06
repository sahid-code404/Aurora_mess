import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type ExpensePeriodClient = Pick<Prisma.TransactionClient, "billingPeriod">;

/**
 * Expenses are formula inputs frozen into immutable billing snapshots. Once a
 * month is billed (including REOPENED periods whose bills remain authoritative),
 * its expense set cannot be created, approved or voided in-place. Corrections
 * after billing must use explicit bill/financial correction lifecycles instead.
 *
 * Call this only after `lockInstitutionFinancialMutation` inside the same
 * transaction so a billing run cannot cross this check before the mutation.
 */
export async function assertExpensePeriodMutable(
  client: ExpensePeriodClient,
  institutionId: string,
  dateKey: string
): Promise<void> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Expense dates use YYYY-MM-DD.", 400);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const period = await client.billingPeriod.findUnique({
    where: { institutionId_year_month: { institutionId, year, month } },
    select: { status: true, generationState: true },
  });

  if (!period) return;

  const frozen =
    period.status === "BILLED" ||
    period.status === "REOPENED" ||
    period.generationState === "CLOSING" ||
    period.generationState === "GENERATING";

  if (frozen) {
    throw new ApiError(
      CODES.BILLING_PERIOD_CLOSED,
      `The billing period for ${year}-${String(month).padStart(2, "0")} is already frozen — expenses can no longer change inside it.`,
      409,
      { date: "This date belongs to a frozen billing period." }
    );
  }
}
