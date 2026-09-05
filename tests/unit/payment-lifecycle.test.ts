import { describe, expect, test } from "bun:test";
import {
  isCurrentPaymentLifecycleStatus,
  isLegacyPaymentRefundStatus,
  isPaymentReadStatus,
  LEGACY_PAYMENT_REFUND_STATUSES,
  PAYMENT_CREDIT_STATUSES,
  PAYMENT_LEDGER_STATUSES,
  PAYMENT_LIFECYCLE_STATUSES,
  PAYMENT_READ_STATUSES,
} from "@/lib/domain/payment-lifecycle";

describe("payment lifecycle", () => {
  test("current writable lifecycle excludes account-level refund states", () => {
    expect(PAYMENT_LIFECYCLE_STATUSES).toEqual(["PENDING", "APPROVED", "REJECTED", "VOIDED"]);
    expect(isCurrentPaymentLifecycleStatus("PENDING")).toBe(true);
    expect(isCurrentPaymentLifecycleStatus("APPROVED")).toBe(true);
    expect(isCurrentPaymentLifecycleStatus("REJECTED")).toBe(true);
    expect(isCurrentPaymentLifecycleStatus("VOIDED")).toBe(true);
    expect(isCurrentPaymentLifecycleStatus("REFUNDED")).toBe(false);
    expect(isCurrentPaymentLifecycleStatus("PARTIALLY_REFUNDED")).toBe(false);
  });

  test("legacy refund-like payment states remain read-compatible only", () => {
    expect(LEGACY_PAYMENT_REFUND_STATUSES).toEqual(["REFUNDED", "PARTIALLY_REFUNDED"]);
    expect(isLegacyPaymentRefundStatus("REFUNDED")).toBe(true);
    expect(isLegacyPaymentRefundStatus("PARTIALLY_REFUNDED")).toBe(true);
    expect(isLegacyPaymentRefundStatus("APPROVED")).toBe(false);

    expect(PAYMENT_READ_STATUSES).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "VOIDED",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
    ]);
    expect(isPaymentReadStatus("REFUNDED")).toBe(true);
    expect(isPaymentReadStatus("PARTIALLY_REFUNDED")).toBe(true);
    expect(isPaymentReadStatus("SOMETHING_ELSE")).toBe(false);
  });

  test("credit and ledger projections use explicit shared compatibility sets", () => {
    expect(PAYMENT_CREDIT_STATUSES).toEqual(["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"]);
    expect(PAYMENT_CREDIT_STATUSES).not.toContain("PENDING");
    expect(PAYMENT_CREDIT_STATUSES).not.toContain("REJECTED");
    expect(PAYMENT_CREDIT_STATUSES).not.toContain("VOIDED");

    expect(PAYMENT_LEDGER_STATUSES).toEqual([
      "APPROVED",
      "VOIDED",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
    ]);
  });
});
