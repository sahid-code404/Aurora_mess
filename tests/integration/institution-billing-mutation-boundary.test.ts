import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { assertExpensePeriodMutable } from "@/lib/domain/expense-period";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";

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

async function createInstitution() {
  return db.institution.create({
    data: {
      name: unique("Phase40 Institution"),
      settings: { create: {} },
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("institution billing mutation boundary", () => {
  test("a second institution financial mutation waits for the first transaction", async () => {
    const institution = await createInstitution();
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondAcquired = false;

    const first = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    await firstLocked.promise;

    const second = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      secondAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  test("a waiter re-evaluates the expense period after billing commits it frozen", async () => {
    const institution = await createInstitution();
    const period = await db.billingPeriod.create({
      data: {
        institutionId: institution.id,
        year: 2088,
        month: 8,
        status: "OPEN",
      },
    });

    const billingLocked = deferred();
    const finishBilling = deferred();
    let expenseLockAcquired = false;

    const billing = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await tx.billingPeriod.update({
        where: { id: period.id },
        data: { generationState: "CLOSING" },
      });
      billingLocked.resolve();
      await finishBilling.promise;
      await tx.billingPeriod.update({
        where: { id: period.id },
        data: { status: "BILLED", generationState: null, billedAt: new Date() },
      });
    });

    await billingLocked.promise;

    const expenseOutcome = db
      .$transaction(async (tx) => {
        await lockInstitutionFinancialMutation(tx, institution.id);
        expenseLockAcquired = true;
        await assertExpensePeriodMutable(tx, institution.id, "2088-08-19");
        return "MUTABLE";
      })
      .then((value) => ({ value, error: null as unknown }))
      .catch((error: unknown) => ({ value: null, error }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(expenseLockAcquired).toBe(false);

    finishBilling.resolve();
    await billing;
    const outcome = await expenseOutcome;

    expect(expenseLockAcquired).toBe(true);
    expect(outcome.value).toBeNull();
    expect(outcome.error).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });
  });

  test("OPEN periods are mutable but BILLED, REOPENED and active-generation periods are frozen", async () => {
    const institution = await createInstitution();
    const period = await db.billingPeriod.create({
      data: {
        institutionId: institution.id,
        year: 2089,
        month: 3,
        status: "OPEN",
      },
    });

    await db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await expect(assertExpensePeriodMutable(tx, institution.id, "2089-03-12")).resolves.toBeUndefined();
    });

    for (const state of [
      { status: "OPEN", generationState: "CLOSING" },
      { status: "BILLED", generationState: null },
      { status: "REOPENED", generationState: null },
    ]) {
      await db.billingPeriod.update({
        where: { id: period.id },
        data: state,
      });

      const outcome = await db
        .$transaction(async (tx) => {
          await lockInstitutionFinancialMutation(tx, institution.id);
          await assertExpensePeriodMutable(tx, institution.id, "2089-03-12");
        })
        .then(() => null)
        .catch((error: unknown) => error);

      expect(outcome).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });
    }
  });
});