import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { createRefund } from "@/lib/domain/refunds";
import { refreshGuestMealLifecycle } from "@/lib/domain/guest-meal-lifecycle";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";
import { invalidateInstitutionCache } from "@/lib/institution";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createInstitutionAndResident() {
  const institution = await db.institution.create({
    data: {
      name: unique("Phase36 Institution"),
      settings: { create: {} },
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("phase36-resident")}@example.test`,
      passwordHash: "phase36-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  return { institution, resident };
}

async function createGeneratedBill(input: {
  institutionId: string;
  residentId: string;
  year: number;
  month: number;
  subtotalMinor: number;
}) {
  const period = await db.billingPeriod.create({
    data: {
      institutionId: input.institutionId,
      year: input.year,
      month: input.month,
      status: "BILLED",
      billedAt: new Date(),
      closedAt: new Date(),
    },
  });
  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: input.institutionId,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("phase36-snapshot"),
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
      institutionId: input.institutionId,
      residentId: input.residentId,
      billingPeriodId: period.id,
      snapshotId: snapshot.id,
      billNumber: unique(`BILL-${input.year}${String(input.month).padStart(2, "0")}`),
      subtotalMinor: input.subtotalMinor,
      adjustmentsMinor: 0,
      paymentsMinor: 0,
      totalDueMinor: input.subtotalMinor,
      dueDate: new Date("2099-12-31T00:00:00.000Z"),
      status: "GENERATED",
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("billing/refund financial boundary", () => {
  test("billing's transaction-scoped lifecycle refresh blocks the mutex-backed payment submission until the boundary commits", async () => {
    const { institution, resident } = await createInstitutionAndResident();
    const barrierReady = deferred();
    const releaseBarrier = deferred();
    let insertFinished = false;

    const billingBoundary = db.$transaction(async (tx) => {
      await refreshGuestMealLifecycle({
        institutionId: institution.id,
        from: new Date("2097-01-01T00:00:00.000Z"),
        to: new Date("2097-01-31T23:59:59.999Z"),
        client: tx,
      });
      barrierReady.resolve();
      await releaseBarrier.promise;
    });

    await barrierReady.promise;

    // Mirrors the Payment POST correctness boundary: the route takes the
    // resident mutex before its idempotency claim and Payment insert.
    const insert = db.$transaction(async (tx) => {
      await lockResidentFinancialMutation(tx, institution.id, resident.id);
      return tx.payment.create({
        data: {
          institutionId: institution.id,
          residentId: resident.id,
          displayNumber: unique("PAY-209701"),
          amountMinor: 1_000,
          method: "UPI",
          status: "PENDING",
        },
      });
    }).then((payment) => {
      insertFinished = true;
      return payment;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(insertFinished).toBe(false);
    expect(await db.payment.count({ where: { institutionId: institution.id } })).toBe(0);

    releaseBarrier.resolve();
    await billingBoundary;
    const payment = await insert;
    expect(insertFinished).toBe(true);
    expect(payment.status).toBe("PENDING");
  });

  test("a refund waiting behind the billing boundary re-evaluates credit after a newly committed bill", async () => {
    const { institution, resident } = await createInstitutionAndResident();
    await db.payment.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        displayNumber: unique("PAY-PHASE36"),
        amountMinor: 10_000,
        method: "UPI",
        status: "APPROVED",
      },
    });
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2097,
      month: 1,
      subtotalMinor: 5_000,
    });
    invalidateInstitutionCache();

    const barrierReady = deferred();
    const releaseBarrier = deferred();

    const billingBoundary = db.$transaction(async (tx) => {
      await refreshGuestMealLifecycle({
        institutionId: institution.id,
        from: new Date("2097-02-01T00:00:00.000Z"),
        to: new Date("2097-02-28T23:59:59.999Z"),
        client: tx,
      });
      barrierReady.resolve();
      await releaseBarrier.promise;

      const period = await tx.billingPeriod.create({
        data: {
          institutionId: institution.id,
          year: 2097,
          month: 2,
          status: "BILLED",
          billedAt: new Date(),
          closedAt: new Date(),
        },
      });
      const snapshot = await tx.billingSnapshot.create({
        data: {
          institutionId: institution.id,
          billingPeriodId: period.id,
          payloadJson: "{}",
          checksum: unique("phase36-new-snapshot"),
          residentCount: 1,
          residentMealCount: 0,
          guestMealCount: 0,
          eligibleExpensesMinor: 0,
          approvedPaymentsMinor: 0,
          mealChargeMinor: 0,
        },
      });
      await tx.bill.create({
        data: {
          institutionId: institution.id,
          residentId: resident.id,
          billingPeriodId: period.id,
          snapshotId: snapshot.id,
          billNumber: unique("BILL-209702"),
          subtotalMinor: 5_000,
          adjustmentsMinor: 0,
          paymentsMinor: 0,
          totalDueMinor: 5_000,
          dueDate: new Date("2097-03-31T00:00:00.000Z"),
          status: "GENERATED",
        },
      });
    });

    await barrierReady.promise;

    const refund = createRefund({
      institutionId: institution.id,
      residentId: resident.id,
      amountMinor: 5_000,
      mode: "ISSUE_REFUND",
      reason: "Phase 36 boundary race",
      actorUserId: "phase36-admin",
      requestId: unique("phase36-refund"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.refund.count({ where: { institutionId: institution.id, residentId: resident.id } })).toBe(0);

    releaseBarrier.resolve();
    await billingBoundary;

    let caught: unknown;
    try {
      await refund;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe(CODES.REFUND_NOT_ELIGIBLE);
    expect(await db.refund.count({ where: { institutionId: institution.id, residentId: resident.id } })).toBe(0);
  });
});
