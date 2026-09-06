import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";

export type PaymentVoidCoverage = {
  approvedPaymentsMinor: number;
  issuedRefundsMinor: number;
  remainingApprovedPaymentsMinor: number;
};

/**
 * Protect the resident-level pooled refund model when an approved payment is
 * voided.
 *
 * Refund Center intentionally resolves excess at RESIDENT level rather than
 * attributing a payout to one arbitrary payment. That means a payment can be
 * voided safely only while the remaining approved-payment pool still covers
 * every completed cash refund already issued to the resident.
 *
 * Call this only AFTER the resident financial mutex is acquired and AFTER the
 * payment is freshly re-read as APPROVED. Refund creation and payment review use
 * the same mutex, so these aggregates cannot race another settlement mutation.
 */
export async function assertPaymentVoidRefundCoverage(
  client: any,
  payment: {
    id: string;
    institutionId: string;
    residentId: string;
    amountMinor: number;
  }
): Promise<PaymentVoidCoverage> {
  const [paymentsAgg, refundsAgg] = await Promise.all([
    client.payment.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: payment.institutionId,
        residentId: payment.residentId,
        status: "APPROVED",
      },
    }),
    client.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: payment.institutionId,
        residentId: payment.residentId,
        status: "COMPLETED",
        mode: "ISSUE_REFUND",
      },
    }),
  ]);

  const approvedPaymentsMinor = paymentsAgg._sum.amountMinor ?? 0;
  const issuedRefundsMinor = refundsAgg._sum.amountMinor ?? 0;
  const remainingApprovedPaymentsMinor = approvedPaymentsMinor - payment.amountMinor;

  if (remainingApprovedPaymentsMinor < issuedRefundsMinor) {
    throw new ApiError(
      CODES.PAYMENT_INVALID_STATE,
      `This payment cannot be voided because ${formatMinor(issuedRefundsMinor)} has already been paid back from this resident's pooled credit. Use an explicit correcting financial entry instead.`,
      409
    );
  }

  return {
    approvedPaymentsMinor,
    issuedRefundsMinor,
    remainingApprovedPaymentsMinor,
  };
}
