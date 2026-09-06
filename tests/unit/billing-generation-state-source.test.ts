import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("billing generation persistence contract", () => {
  test("period status and generation state expose only committed runtime states", () => {
    const schema = source("prisma/schema.prisma");
    const billing = source("src/lib/domain/billing.ts");
    const types = source("src/components/app/admin/_shared/types.ts");
    const expensePeriod = source("src/lib/domain/expense-period.ts");
    const start = schema.indexOf("model BillingPeriod {");
    const end = schema.indexOf("model BillingSnapshot", start);
    const model = schema.slice(start, end);

    expect(model).toContain("// OPEN | BILLED | REOPENED");
    expect(model).toContain("// CLOSING | COMPLETED; failed transactions roll back to null");
    expect(model).not.toContain("generationError");
    expect(model).not.toContain("GENERATING");
    expect(model).not.toContain("FAILED");
    expect(types).not.toContain('"OPEN" | "CLOSING" | "BILLED"');
    expect(billing).not.toContain('generationState === "GENERATING"');
    expect(billing).not.toContain("generationError:");
    expect(expensePeriod).not.toContain('generationState === "GENERATING"');
  });

  test("billing still claims generation atomically and commits canonical terminal state", () => {
    const billing = source("src/lib/domain/billing.ts");
    expect(billing).toContain('status: "OPEN", generationState: null');
    expect(billing).toContain('data: { generationState: "CLOSING" }');
    expect(billing).toContain('status: "BILLED"');
    expect(billing).toContain('generationState: "COMPLETED"');
    expect(billing).toContain('data: { status: "REOPENED", generationState: null }');
  });

  test("migration audits legacy states and preserves periods with generated bills", () => {
    const migration = source("prisma/migrations/20260906_130000_billing_generation_state_integrity/migration.sql");
    expect(migration).toContain("BILLING_GENERATION_STATE_NORMALIZED");
    expect(migration).toContain('EXISTS (SELECT 1 FROM "Bill"');
    expect(migration).toContain("THEN 'status=BILLED; generationState=COMPLETED'");
    expect(migration).toContain('DROP COLUMN IF EXISTS "generationError"');
  });
});
