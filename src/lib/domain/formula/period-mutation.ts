import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type Client = Pick<Prisma.TransactionClient, "billingPeriod">;

/**
 * Formula definitions/values are billing inputs. Call this only after the
 * Institution financial mutex is held in the same transaction.
 *
 * BILLED and REOPENED periods are historical; an in-flight generation claim is
 * equally immutable because the snapshot is being assembled under that claim.
 */
export async function assertFormulaInputPeriodMutable(
  client: Client,
  institutionId: string,
  year: number,
  month: number
): Promise<void> {
  const period = await client.billingPeriod.findUnique({
    where: { institutionId_year_month: { institutionId, year, month } },
    select: { status: true, generationState: true },
  });
  if (!period) return;

  if (
    period.status === "BILLED" ||
    period.status === "REOPENED" ||
    period.generationState === "CLOSING"
  ) {
    throw new ApiError(
      CODES.BILLING_PERIOD_CLOSED,
      `Billing period ${year}-${String(month).padStart(2, "0")} is frozen. Formula inputs for that period can no longer change.`,
      409,
      { period: "Use a future open billing period for formula or variable changes." }
    );
  }
}
