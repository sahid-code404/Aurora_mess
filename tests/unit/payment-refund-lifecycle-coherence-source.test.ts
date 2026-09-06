import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("pooled refund / payment lifecycle source contracts", () => {
  test("Payment exposes only its real review lifecycle across financial readers", () => {
    const paths = [
      "src/app/api/v1/admin/payments/route.ts",
      "src/app/api/v1/payments/route.ts",
      "src/app/api/v1/admin/funds/route.ts",
      "src/lib/domain/funds.ts",
      "src/lib/domain/formula/providers/funds.ts",
      "src/lib/domain/billing.ts",
      "src/lib/domain/ledger.ts",
      "src/components/app/resident/_shared/types.ts",
      "src/components/glass/StatusBadge.tsx",
      "prisma/schema.prisma",
    ];

    for (const path of paths) {
      const text = source(path);
      expect(text).not.toContain("PARTIALLY_REFUNDED");
      expect(text).not.toContain('REFUNDED:');
    }

    expect(source("src/app/api/v1/admin/payments/route.ts")).toContain(
      'const STATUSES = ["PENDING", "APPROVED", "REJECTED", "VOIDED"];'
    );
    expect(source("src/app/api/v1/payments/route.ts")).toContain(
      '!["PENDING", "APPROVED", "REJECTED", "VOIDED"].includes(status)'
    );
  });

  test("all approved-payment financial aggregates now use APPROVED as the single credit state", () => {
    for (const path of [
      "src/app/api/v1/admin/payments/route.ts",
      "src/app/api/v1/payments/route.ts",
      "src/app/api/v1/admin/funds/route.ts",
      "src/lib/domain/funds.ts",
      "src/lib/domain/formula/providers/funds.ts",
      "src/lib/domain/billing.ts",
    ]) {
      const text = source(path);
      expect(text).not.toContain('["APPROVED", "REFUNDED"');
    }

    expect(source("src/lib/domain/funds.ts")).toContain('where: { residentId, status: "APPROVED" }');
    expect(source("src/lib/domain/formula/providers/funds.ts")).toContain(
      'where: { institutionId, status: "APPROVED" }'
    );
  });

  test("payment void locks the resident, re-reads payment state, then checks pooled refund coverage before mutation", () => {
    const text = source("src/app/api/v1/admin/payments/[id]/void/route.ts");
    expect(text).toContain('import { assertPaymentVoidRefundCoverage } from "@/lib/domain/payment-lifecycle";');

    const preRead = text.indexOf("const paymentBeforeLock = await tx.payment.findFirst");
    const lock = text.indexOf("await lockResidentFinancialMutation(tx, ctx.institutionId, paymentBeforeLock.residentId);");
    const freshRead = text.indexOf("const payment = await tx.payment.findFirst", lock);
    const coverage = text.indexOf("const refundCoverage = await assertPaymentVoidRefundCoverage(tx, payment);", freshRead);
    const mutation = text.indexOf("const guard = await tx.payment.updateMany", coverage);

    expect(preRead).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(preRead);
    expect(freshRead).toBeGreaterThan(lock);
    expect(coverage).toBeGreaterThan(freshRead);
    expect(mutation).toBeGreaterThan(coverage);
    expect(text).not.toContain('payment.status === "REFUNDED"');
  });

  test("coverage helper counts only approved receipts and completed cash payouts", () => {
    const text = source("src/lib/domain/payment-lifecycle.ts");
    expect(text).toContain('status: "APPROVED"');
    expect(text).toContain('status: "COMPLETED"');
    expect(text).toContain('mode: "ISSUE_REFUND"');
    expect(text).toContain("remainingApprovedPaymentsMinor < issuedRefundsMinor");
    expect(text).toContain("CODES.PAYMENT_INVALID_STATE");
  });

  test("new refunds are resident-level pooled credit without arbitrary payment attribution", () => {
    const route = source("src/app/api/v1/admin/refunds/route.ts");
    const domain = source("src/lib/domain/refunds.ts");
    const schema = source("prisma/schema.prisma");

    expect(route).not.toContain("paymentId: z.string");
    expect(route).not.toContain("body.paymentId");
    expect(domain).not.toContain("input.paymentId");
    expect(domain).toContain("paymentId: null");
    expect(domain).toContain("Refunds are intentionally not attributed to one arbitrary payment.");
    expect(schema).toContain("legacy provenance only; new refunds use resident-level pooled credit");
  });

  test("resident payment KPI no longer advertises an unreachable pending-refund state", () => {
    const api = source("src/app/api/v1/payments/route.ts");
    const types = source("src/components/app/resident/_shared/types.ts");
    const ui = source("src/components/app/resident/payments.tsx");

    expect(api).not.toContain("refundPendingCount");
    expect(types).not.toContain("refundPendingCount");
    expect(ui).not.toContain("refundPendingCount");
    expect(ui).toContain('value={meta?.refundsThisMonthFormatted ?? "₹0.00"}');
    expect(ui).toContain('"Processed this month"');
  });

  test("migration normalizes any legacy refund-labelled Payment rows to APPROVED", () => {
    const migration = source("prisma/migrations/20260906_060000_normalize_payment_refund_states/migration.sql");
    expect(migration).toContain('SET "status" = \'APPROVED\'');
    expect(migration).toContain("WHERE \"status\" IN ('REFUNDED', 'PARTIALLY_REFUNDED')");
  });
});
