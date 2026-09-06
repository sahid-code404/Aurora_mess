import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const billing = source("src/lib/domain/billing.ts");
const guestLifecycle = source("src/lib/domain/guest-meal-lifecycle.ts");
const payments = source("src/app/api/v1/payments/route.ts");
const refunds = source("src/lib/domain/refunds.ts");

describe("billing/refund financial boundary source ordering", () => {
  test("billing establishes its transaction boundary before pending-payment and credit readiness reads", () => {
    const lifecycle = billing.indexOf("await refreshGuestMealLifecycle({");
    const pendingPayments = billing.indexOf("const pendingPayments = await client.payment.count(");
    const variables = billing.indexOf("const variables = await gatherPeriodVariables(");
    expect(lifecycle).toBeGreaterThan(-1);
    expect(billing.slice(lifecycle, pendingPayments)).toContain("client,");
    expect(lifecycle).toBeLessThan(pendingPayments);
    expect(pendingPayments).toBeLessThan(variables);
  });

  test("transaction-scoped institution lifecycle refresh acquires every resident mutex first", () => {
    expect(guestLifecycle).toContain(
      'import { lockInstitutionResidentFinancialMutations } from "@/lib/domain/financial-lock";'
    );
    expect(guestLifecycle).toContain("if (options.client && !options.hostResidentId)");
    const barrier = guestLifecycle.indexOf("await lockInstitutionResidentFinancialMutations(");
    const guestRead = guestLifecycle.indexOf("const rows = await client.guestMealRequest.findMany(");
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(guestRead);
  });

  test("new payment submission takes the resident mutex before idempotency claim and Payment insert", () => {
    expect(payments).toContain(
      'import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";'
    );
    const transaction = payments.indexOf("return await db.$transaction(async (tx) => {");
    const lock = payments.indexOf("await lockResidentFinancialMutation(", transaction);
    const claim = payments.indexOf("const claim = await claimIdempotencyKey(", transaction);
    const create = payments.indexOf("const payment = await tx.payment.create(", transaction);
    expect(transaction).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(transaction);
    expect(lock).toBeLessThan(claim);
    expect(claim).toBeLessThan(create);
  });

  test("refund creation locks the resident before authoritative eligibility and pooled refund insert", () => {
    expect(refunds).toContain(
      'import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";'
    );
    const transaction = refunds.indexOf("return db.$transaction(async (tx) => {");
    const lock = refunds.indexOf("await lockResidentFinancialMutation(", transaction);
    const residentRead = refunds.indexOf("const resident = await tx.user.findFirst(", transaction);
    const eligibility = refunds.indexOf("const eligibility = await refundEligibilityForResident(", transaction);
    const create = refunds.indexOf("const created = await tx.refund.create(", eligibility);

    expect(transaction).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(transaction);
    expect(lock).toBeLessThan(residentRead);
    expect(residentRead).toBeLessThan(eligibility);
    expect(eligibility).toBeLessThan(create);
    expect(refunds).not.toContain("input.paymentId");
    expect(refunds.slice(create)).toContain("paymentId: null");
  });
});
