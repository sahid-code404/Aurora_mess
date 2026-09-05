import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";
import { recomputeBillSettlement } from "@/lib/domain/funds";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

async function createFixture() {
  const institution = await db.institution.create({
    data: {
      name: unique("Phase35 Institution"),
      settings: { create: {} },
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("phase35-resident")}@example.test`,
      passwordHash: "phase35-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const period = await db.billingPeriod.create({
    data: {
      institutionId: institution.id,
      year: 2098,
      month: 11,
      status: "BILLED",
      billedAt: new Date(),
    },
  });
  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: institution.id,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("phase35-snapshot"),
      residentCount: 1,
      residentMealCount: 0,
      guestMealCount: 0,
      eligibleExpensesMinor: 0,
      approvedPaymentsMinor: 0,
      mealChargeMinor: 0,
    },
  });
  const bill = await db.bill.create({
    data: {
      institutionId: institution.id,
      residentId: resident.id,
      billingPeriodId: period.id,
      snapshotId: snapshot.id,
      billNumber: unique("BILL-209811"),
      subtotalMinor: 10_000,
      adjustmentsMinor: 0,
      paymentsMinor: 0,
      totalDueMinor: 10_000,
      dueDate: new Date("2098-12-31T00:00:00.000Z"),
      status: "GENERATED",
    },
  });
  return { institution, resident, bill };
}

async function createPayment(institutionId: string, residentId: string, amountMinor: number, status = "PENDING") {
  return db.payment.create({
    data: {
      institutionId,
      residentId,
      displayNumber: unique("PAY-209811"),
      amountMinor,
      method: "UPI",
      status,
    },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("resident settlement serialization", () => {
  test("a second payment approval cannot cross the resident mutex and final settlement sees both approvals", async () => {
    const { institution, resident, bill } = await createFixture();
    const firstPayment = await createPayment(institution.id, resident.id, 6_000);
    const secondPayment = await createPayment(institution.id, resident.id, 6_000);

    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondLockAcquired = false;

    const first = db.$transaction(async (tx) => {
      await lockResidentFinancialMutation(tx, institution.id, resident.id);
      const changed = await tx.payment.updateMany({
        where: { id: firstPayment.id, status: "PENDING" },
        data: { status: "APPROVED" },
      });
      expect(changed.count).toBe(1);
      firstLocked.resolve();
      await releaseFirst.promise;
      await recomputeBillSettlement(tx, resident.id);
    });

    await firstLocked.promise;

    const second = db.$transaction(async (tx) => {
      await lockResidentFinancialMutation(tx, institution.id, resident.id);
      secondLockAcquired = true;
      const changed = await tx.payment.updateMany({
        where: { id: secondPayment.id, status: "PENDING" },
        data: { status: "APPROVED" },
      });
      expect(changed.count).toBe(1);
      await recomputeBillSettlement(tx, resident.id);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondLockAcquired).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    const payments = await db.payment.findMany({
      where: { id: { in: [firstPayment.id, secondPayment.id] } },
      orderBy: { id: "asc" },
    });
    expect(payments.map((payment) => payment.status)).toEqual(["APPROVED", "APPROVED"]);

    const updated = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(updated.paymentsMinor).toBe(10_000);
    expect(updated.totalDueMinor).toBe(0);
    expect(updated.status).toBe("PAID");
  });

  test("concurrent approve and void settle from the final committed approved-payment pool", async () => {
    const { institution, resident, bill } = await createFixture();
    const approved = await createPayment(institution.id, resident.id, 7_000, "APPROVED");
    const pending = await createPayment(institution.id, resident.id, 5_000, "PENDING");

    await db.$transaction(async (tx) => {
      await lockResidentFinancialMutation(tx, institution.id, resident.id);
      await recomputeBillSettlement(tx, resident.id);
    });

    const before = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(before.paymentsMinor).toBe(7_000);
    expect(before.totalDueMinor).toBe(3_000);

    const results = await Promise.all([
      db.$transaction(async (tx) => {
        await lockResidentFinancialMutation(tx, institution.id, resident.id);
        const changed = await tx.payment.updateMany({
          where: { id: approved.id, status: "APPROVED" },
          data: { status: "VOIDED" },
        });
        expect(changed.count).toBe(1);
        await recomputeBillSettlement(tx, resident.id);
      }),
      db.$transaction(async (tx) => {
        await lockResidentFinancialMutation(tx, institution.id, resident.id);
        const changed = await tx.payment.updateMany({
          where: { id: pending.id, status: "PENDING" },
          data: { status: "APPROVED" },
        });
        expect(changed.count).toBe(1);
        await recomputeBillSettlement(tx, resident.id);
      }),
    ]);
    expect(results).toHaveLength(2);

    const finalPayments = await db.payment.findMany({
      where: { id: { in: [approved.id, pending.id] } },
      orderBy: { id: "asc" },
    });
    expect(new Set(finalPayments.map((payment) => payment.status))).toEqual(new Set(["VOIDED", "APPROVED"]));

    const updated = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(updated.paymentsMinor).toBe(5_000);
    expect(updated.totalDueMinor).toBe(5_000);
    expect(updated.status).toBe("PARTIALLY_PAID");
  });
});
