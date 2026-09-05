import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ensureAccounts } from "@/lib/domain/ledger";
import { recomputeBillSettlement, residentFundsSummary } from "@/lib/domain/funds";
import { createRefund } from "@/lib/domain/refunds";
import { invalidateInstitutionCache } from "@/lib/institution";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createInstitution() {
  return db.institution.create({
    data: {
      name: unique("Payment Lifecycle Mess"),
      settings: {
        create: {
          deficitThresholdMinor: 100000,
          gracePeriodDays: 7,
          restrictMealsOnDeficit: true,
          deficitPolicyEnabled: true,
        },
      },
    },
  });
}

async function createResident(institutionId: string) {
  return db.user.create({
    data: {
      institutionId,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("payment-lifecycle-resident")}@example.test`,
      passwordHash: "integration-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
}

async function createBill(institutionId: string, residentId: string, subtotalMinor: number) {
  const period = await db.billingPeriod.create({
    data: {
      institutionId,
      year: 2026,
      month: 7,
      status: "BILLED",
      billedAt: new Date(),
      closedAt: new Date(),
    },
  });
  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("payment-lifecycle-snapshot"),
      residentCount: 1,
      residentMealCount: 0,
      guestMealCount: 0,
      eligibleExpensesMinor: 0,
      approvedPaymentsMinor: 0,
      mealChargeMinor: 0,
    },
  });
  return db.bill.create({
    data: {
      institutionId,
      residentId,
      billingPeriodId: period.id,
      snapshotId: snapshot.id,
      billNumber: unique("BILL-PAYMENT-LIFECYCLE"),
      subtotalMinor,
      totalDueMinor: subtotalMinor,
      dueDate: new Date("2027-01-31T00:00:00.000Z"),
      status: "GENERATED",
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("Payment and Refund lifecycle separation", () => {
  test("modern refund keeps the referenced source Payment APPROVED", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    const payment = await db.payment.create({
      data: {
        institutionId: institution.id,
        displayNumber: unique("PAY-MODERN-REFUND"),
        residentId: resident.id,
        amountMinor: 10_000,
        method: "UPI",
        status: "APPROVED",
      },
    });
    await db.paymentStatusHistory.create({
      data: {
        paymentId: payment.id,
        fromStatus: "PENDING",
        toStatus: "APPROVED",
        changedByUserId: "integration-admin",
      },
    });
    await createBill(institution.id, resident.id, 6_000);
    await recomputeBillSettlement(db, resident.id);
    await ensureAccounts(institution.id);
    invalidateInstitutionCache();

    const refund = await createRefund({
      institutionId: institution.id,
      residentId: resident.id,
      paymentId: payment.id,
      amountMinor: 1_000,
      mode: "ISSUE_REFUND",
      reason: "Prove refund and payment state stay separate",
      actorUserId: "integration-admin",
      requestId: unique("payment-refund-separation"),
    });

    expect(refund.status).toBe("COMPLETED");
    expect(refund.paymentId).toBe(payment.id);

    const storedPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(storedPayment.status).toBe("APPROVED");

    const refundLikeTransitions = await db.paymentStatusHistory.count({
      where: {
        paymentId: payment.id,
        toStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] },
      },
    });
    expect(refundLikeTransitions).toBe(0);

    const storedRefund = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(storedRefund.paymentId).toBe(payment.id);
    expect(storedRefund.mode).toBe("ISSUE_REFUND");
    expect(storedRefund.amountMinor).toBe(1_000);
  });

  test("legacy refund-like Payment rows remain part of historical credit projection", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);

    await db.payment.createMany({
      data: [
        {
          institutionId: institution.id,
          displayNumber: unique("PAY-LEGACY-REFUNDED"),
          residentId: resident.id,
          amountMinor: 2_000,
          method: "UPI",
          status: "REFUNDED",
        },
        {
          institutionId: institution.id,
          displayNumber: unique("PAY-LEGACY-PARTIAL"),
          residentId: resident.id,
          amountMinor: 3_000,
          method: "CASH",
          status: "PARTIALLY_REFUNDED",
        },
      ],
    });
    invalidateInstitutionCache();

    const summary = await residentFundsSummary(resident.id);
    expect(summary.creditsMinor).toBe(5_000);
    expect(summary.availableMinor).toBe(5_000);
  });
});
