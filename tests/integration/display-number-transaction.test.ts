import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { nextBillNumbers, nextExpenseNumber, nextPaymentNumber } from "@/lib/ids";

const phase26Prefix = "EXP-209912-";
const phase26Key = "EXP:209912";
const phase27ExpensePrefix = "EXP-209911-";
const phase27ExpenseKey = "EXP:209911";
const phase27PaymentPrefix = "PAY-209910-";
const phase27PaymentKey = "PAY:209910";
const phase33BillKey = "BILL:209912";

async function deleteSequence(key: string) {
  await db.$executeRaw`DELETE FROM "DisplayNumberSequence" WHERE "key" = ${key}`;
}

afterAll(async () => {
  await db.expense.deleteMany({
    where: {
      OR: [
        { displayNumber: { startsWith: phase26Prefix } },
        { displayNumber: { startsWith: phase27ExpensePrefix } },
      ],
    },
  });
  await db.payment.deleteMany({
    where: { displayNumber: { startsWith: phase27PaymentPrefix } },
  });
  await Promise.all([
    deleteSequence(phase26Key),
    deleteSequence(phase27ExpenseKey),
    deleteSequence(phase27PaymentKey),
    deleteSequence(phase33BillKey),
  ]);
  await db.$disconnect();
});

describe("transaction-aware display-number allocation", () => {
  test("expense allocator sees an uncommitted expense created in the caller transaction", async () => {
    const testDate = new Date("2099-12-15T12:00:00.000Z");

    // Keep this deterministic even when a developer re-runs the integration suite
    // against the same local PostgreSQL database.
    await db.expense.deleteMany({
      where: { displayNumber: { startsWith: phase26Prefix } },
    });
    await deleteSequence(phase26Key);

    await db.$transaction(async (tx) => {
      await tx.expense.create({
        data: {
          institutionId: `phase26-institution-${crypto.randomUUID()}`,
          displayNumber: "EXP-209912-0001",
          date: testDate,
          status: "PENDING",
          source: "DIRECT",
          description: "Phase 26 uncommitted transaction visibility regression",
          submittedByUserId: `phase26-user-${crypto.randomUUID()}`,
          totalMinor: 100,
        },
      });

      const next = await nextExpenseNumber(tx, testDate);
      expect(next).toBe("EXP-209912-0002");
    });
  });

  test("parallel payment reservations are unique and gap-free for a fresh month", async () => {
    const testDate = new Date("2099-10-15T12:00:00.000Z");
    await db.payment.deleteMany({
      where: { displayNumber: { startsWith: phase27PaymentPrefix } },
    });
    await deleteSequence(phase27PaymentKey);

    const numbers = await Promise.all(
      Array.from({ length: 16 }, () => nextPaymentNumber(db, testDate))
    );

    expect(new Set(numbers).size).toBe(16);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 16 }, (_, index) =>
        `PAY-209910-${String(index + 1).padStart(4, "0")}`
      )
    );
  });

  test("concurrent expense transactions allocate distinct numbers and both commit", async () => {
    const testDate = new Date("2099-11-15T12:00:00.000Z");
    await db.expense.deleteMany({
      where: { displayNumber: { startsWith: phase27ExpensePrefix } },
    });
    await deleteSequence(phase27ExpenseKey);

    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        db.$transaction(async (tx) => {
          const displayNumber = await nextExpenseNumber(tx, testDate);
          return tx.expense.create({
            data: {
              institutionId: `phase27-institution-${index}`,
              displayNumber,
              date: testDate,
              status: "PENDING",
              source: "DIRECT",
              description: `Phase 27 concurrent allocation ${index}`,
              submittedByUserId: `phase27-user-${index}`,
              totalMinor: 100 + index,
            },
            select: { displayNumber: true },
          });
        })
      )
    );

    const numbers = created.map((row) => row.displayNumber);
    expect(new Set(numbers).size).toBe(8);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        `EXP-209911-${String(index + 1).padStart(4, "0")}`
      )
    );
  });

  test("concurrent bill transactions reserve distinct contiguous ranges for the same month", async () => {
    await deleteSequence(phase33BillKey);

    const batches = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.$transaction((tx) => nextBillNumbers(2099, 12, 5, tx))
      )
    );

    for (const batch of batches) {
      expect(batch).toHaveLength(5);
      const suffixes = batch.map((value) => Number(value.split("-")[2]));
      expect(suffixes).toEqual(
        Array.from({ length: 5 }, (_, index) => suffixes[0] + index)
      );
    }

    const numbers = batches.flat();
    expect(new Set(numbers).size).toBe(20);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        `BILL-209912-${String(index + 1).padStart(4, "0")}`
      )
    );
  });
});
