import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const billing = source("src/lib/domain/billing.ts");
const guestLifecycle = source("src/lib/domain/guest-meal-lifecycle.ts");
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
    const barrier = guestLifecycle.indexOf("await lockInstitutionResidentFinancialMutations(");
    const guestRead = guestLifecycle.indexOf("const rows = await client.guestMealRequest.findMany(");
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(guestRead);
  });

  test("refund creation locks the resident before payment linkage or eligibility is read", () => {
    expect(refunds).toContain(
      'import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";'
    );
    const lock = refunds.indexOf("await lockResidentFinancialMutation(");
    const paymentLink = refunds.indexOf("if (input.paymentId)");
    const eligibility = refunds.indexOf("const eligibility = await refundEligibilityForResident(");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(paymentLink);
    expect(paymentLink).toBeLessThan(eligibility);
  });
});
