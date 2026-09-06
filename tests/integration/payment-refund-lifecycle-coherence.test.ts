import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { assertPaymentVoidRefundCoverage } from "@/lib/domain/payment-lifecycle";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createFixture() {
  const institution = await db.institution.create({
    data: {
      name: unique("Phase44 Institution"),
      settings: { create: {} },
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("phase44-resident")}@example.test`,
      passwordHash: "integration-test-only",
    },
  });
  return { institution, resident };
}

async function approvedPayment(institutionId: string, residentId: string, amountMinor: number) {
  return db.payment.create({
    data: {
      institutionId,
      displayNumber: unique("PAY-PHASE44"),
      residentId,
      amountMinor,
      method: "UPI",
      status: "APPROVED",
    },
  });
}

async function completedCashRefund(institutionId: string, residentId: string, amountMinor: number) {
  return db.refund.create({
    data: {
      institutionId,
      residentId,
      paymentId: null,
      amountMinor,
      mode: "ISSUE_REFUND",
      reason: "Phase 44 pooled refund fixture",
      status: "COMPLETED",
      createdByUserId: "phase44-admin",
      completedAt: new Date(),
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("pooled refund / payment lifecycle coherence", () => {
  test("void is allowed when other approved payments still cover every issued cash refund", async () => {
    const { institution, resident } = await createFixture();
    await approvedPayment(institution.id, resident.id, 7_000);
    const candidate = await approvedPayment(institution.id, resident.id, 5_000);
    await completedCashRefund(institution.id, resident.id, 6_000);

    const coverage = await db.$transaction((tx) => assertPaymentVoidRefundCoverage(tx, candidate));

    expect(coverage.approvedPaymentsMinor).toBe(12_000);
    expect(coverage.issuedRefundsMinor).toBe(6_000);
    expect(coverage.remainingApprovedPaymentsMinor).toBe(7_000);
  });

  test("void is rejected when it would leave issued refunds larger than the remaining approved-payment pool", async () => {
    const { institution, resident } = await createFixture();
    const candidate = await approvedPayment(institution.id, resident.id, 7_000);
    await approvedPayment(institution.id, resident.id, 5_000);
    await completedCashRefund(institution.id, resident.id, 6_000);

    const error = await db
      .$transaction((tx) => assertPaymentVoidRefundCoverage(tx, candidate))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: CODES.PAYMENT_INVALID_STATE, status: 409 });
  });

  test("only APPROVED payments and completed ISSUE_REFUND payouts participate in coverage", async () => {
    const { institution, resident } = await createFixture();
    const candidate = await approvedPayment(institution.id, resident.id, 4_000);
    await approvedPayment(institution.id, resident.id, 8_000);

    await db.payment.create({
      data: {
        institutionId: institution.id,
        displayNumber: unique("PAY-PHASE44-VOIDED"),
        residentId: resident.id,
        amountMinor: 50_000,
        method: "CASH",
        status: "VOIDED",
      },
    });
    await db.refund.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        paymentId: null,
        amountMinor: 50_000,
        mode: "CARRY_FORWARD",
        reason: "Informational carry forward",
        status: "COMPLETED",
        createdByUserId: "phase44-admin",
        completedAt: new Date(),
      },
    });
    await db.refund.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        paymentId: null,
        amountMinor: 50_000,
        mode: "ISSUE_REFUND",
        reason: "Incomplete payout must not count",
        status: "PROCESSING",
        createdByUserId: "phase44-admin",
      },
    });
    await completedCashRefund(institution.id, resident.id, 7_000);

    const coverage = await db.$transaction((tx) => assertPaymentVoidRefundCoverage(tx, candidate));
    expect(coverage.approvedPaymentsMinor).toBe(12_000);
    expect(coverage.issuedRefundsMinor).toBe(7_000);
    expect(coverage.remainingApprovedPaymentsMinor).toBe(8_000);
  });
});
