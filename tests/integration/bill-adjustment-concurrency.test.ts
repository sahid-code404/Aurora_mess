import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { createBillAdjustment } from "@/lib/domain/bill-adjustments";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

async function createFixture(subtotalMinor = 10_000) {
  const institution = await db.institution.create({
    data: {
      name: unique("Phase34 Institution"),
      settings: { create: {} },
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("phase34-resident")}@example.test`,
      passwordHash: "phase34-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const period = await db.billingPeriod.create({
    data: {
      institutionId: institution.id,
      year: 2098,
      month: 12,
      status: "BILLED",
      billedAt: new Date(),
    },
  });
  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: institution.id,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("phase34-snapshot"),
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
      billNumber: unique("BILL-209812"),
      subtotalMinor,
      adjustmentsMinor: 0,
      paymentsMinor: 0,
      totalDueMinor: subtotalMinor,
      dueDate: new Date("2099-01-31T00:00:00.000Z"),
      status: "GENERATED",
    },
  });
  return { institution, resident, bill };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("concurrent bill adjustment integrity", () => {
  test("two concurrent credits cannot jointly reduce the bill below zero", async () => {
    const { institution, bill } = await createFixture(10_000);

    const results = await Promise.allSettled([
      createBillAdjustment({
        institutionId: institution.id,
        billId: bill.id,
        amountMinor: -6_000,
        reason: "Phase 34 concurrent credit A",
        adminUserId: unique("admin-a"),
        requestId: unique("request-a"),
      }),
      createBillAdjustment({
        institutionId: institution.id,
        billId: bill.id,
        amountMinor: -6_000,
        reason: "Phase 34 concurrent credit B",
        adminUserId: unique("admin-b"),
        requestId: unique("request-b"),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const updated = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(updated.adjustmentsMinor).toBe(-6_000);
    expect(updated.subtotalMinor + updated.adjustmentsMinor).toBe(4_000);
    expect(updated.totalDueMinor).toBe(4_000);

    const adjustments = await db.billAdjustment.findMany({ where: { billId: bill.id } });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.amountMinor).toBe(-6_000);

    const journals = await db.ledgerJournal.findMany({
      where: { institutionId: institution.id, refType: "BILL_ADJUSTMENT" },
    });
    expect(journals).toHaveLength(1);
    expect(journals[0]?.refId).toBe(adjustments[0]?.id);
  });

  test("two concurrent positive adjustments both persist without a lost aggregate update", async () => {
    const { institution, bill } = await createFixture(10_000);

    const results = await Promise.allSettled([
      createBillAdjustment({
        institutionId: institution.id,
        billId: bill.id,
        amountMinor: 1_000,
        reason: "Phase 34 concurrent charge A",
        adminUserId: unique("admin-c"),
        requestId: unique("request-c"),
      }),
      createBillAdjustment({
        institutionId: institution.id,
        billId: bill.id,
        amountMinor: 1_000,
        reason: "Phase 34 concurrent charge B",
        adminUserId: unique("admin-d"),
        requestId: unique("request-d"),
      }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const updated = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(updated.adjustmentsMinor).toBe(2_000);
    expect(updated.subtotalMinor + updated.adjustmentsMinor).toBe(12_000);
    expect(updated.totalDueMinor).toBe(12_000);

    const adjustments = await db.billAdjustment.findMany({ where: { billId: bill.id } });
    expect(adjustments).toHaveLength(2);
    expect(adjustments.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(2_000);

    const journals = await db.ledgerJournal.findMany({
      where: { institutionId: institution.id, refType: "BILL_ADJUSTMENT" },
    });
    expect(journals).toHaveLength(2);
    expect(new Set(journals.map((journal) => journal.refId)).size).toBe(2);
  });
});
