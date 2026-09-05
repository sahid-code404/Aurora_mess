/**
 * PAYMENT LIFECYCLE — one source of truth for payment row states.
 *
 * Current authoritative lifecycle:
 *   PENDING -> APPROVED | REJECTED
 *   APPROVED -> VOIDED (correction/reversal)
 *
 * Refunds are account-level, post-billing `Refund` records. They do NOT mutate
 * the source Payment row. `REFUNDED` / `PARTIALLY_REFUNDED` are retained only
 * as read-only compatibility values for historical databases created before
 * the Refund lifecycle was separated from Payment.
 */

export const PAYMENT_LIFECYCLE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "VOIDED"] as const;
export type PaymentLifecycleStatus = (typeof PAYMENT_LIFECYCLE_STATUSES)[number];

export const LEGACY_PAYMENT_REFUND_STATUSES = ["REFUNDED", "PARTIALLY_REFUNDED"] as const;
export type LegacyPaymentRefundStatus = (typeof LEGACY_PAYMENT_REFUND_STATUSES)[number];

export const PAYMENT_READ_STATUSES = [
  ...PAYMENT_LIFECYCLE_STATUSES,
  ...LEGACY_PAYMENT_REFUND_STATUSES,
] as const;
export type PaymentReadStatus = (typeof PAYMENT_READ_STATUSES)[number];

/** States that represent money which entered resident credit historically. */
export const PAYMENT_CREDIT_STATUSES = [
  "APPROVED",
  ...LEGACY_PAYMENT_REFUND_STATUSES,
] as const;

/** Payment rows that can legitimately participate in ledger reconciliation. */
export const PAYMENT_LEDGER_STATUSES = [
  "APPROVED",
  "VOIDED",
  ...LEGACY_PAYMENT_REFUND_STATUSES,
] as const;

export function isPaymentReadStatus(value: string): value is PaymentReadStatus {
  return (PAYMENT_READ_STATUSES as readonly string[]).includes(value);
}

export function isLegacyPaymentRefundStatus(value: string): value is LegacyPaymentRefundStatus {
  return (LEGACY_PAYMENT_REFUND_STATUSES as readonly string[]).includes(value);
}

export function isCurrentPaymentLifecycleStatus(value: string): value is PaymentLifecycleStatus {
  return (PAYMENT_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}
