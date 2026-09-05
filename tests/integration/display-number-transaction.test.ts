import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { nextExpenseNumber } from "@/lib/ids";

const phase26Prefix = "EXP-209912-";

afterAll(async () => {
  await db.expense.deleteMany({
    where: { displayNumber: { startsWith: phase26Prefix } },
  });
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
});
