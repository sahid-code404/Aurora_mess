import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const approve = source("src/app/api/v1/admin/payments/[id]/approve/route.ts");
const voidPayment = source("src/app/api/v1/admin/payments/[id]/void/route.ts");
const adjustment = source("src/lib/domain/bill-adjustments.ts");

describe("resident settlement lock ordering", () => {
  test("payment approve locks the resident before changing PENDING to APPROVED", () => {
    expect(approve).toContain('import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";');
    const lock = approve.indexOf("await lockResidentFinancialMutation(");
    const transition = approve.indexOf("const guard = await tx.payment.updateMany(");
    const settle = approve.indexOf("const settlement = await recomputeBillSettlement(");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(transition);
    expect(transition).toBeLessThan(settle);
  });

  test("payment void locks the resident before changing APPROVED to VOIDED", () => {
    expect(voidPayment).toContain('import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";');
    const lock = voidPayment.indexOf("await lockResidentFinancialMutation(");
    const transition = voidPayment.indexOf("const guard = await tx.payment.updateMany(");
    const settle = voidPayment.indexOf("const reversal = await recomputeBillSettlement(");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(transition);
    expect(transition).toBeLessThan(settle);
  });

  test("bill adjustments keep global resident-to-bill lock ordering", () => {
    const residentLock = adjustment.indexOf("await lockResidentFinancialMutation(");
    const billLock = adjustment.indexOf("FOR UPDATE");
    const settle = adjustment.indexOf("await recomputeBillSettlement(");
    expect(residentLock).toBeGreaterThan(-1);
    expect(residentLock).toBeLessThan(billLock);
    expect(billLock).toBeLessThan(settle);
  });
});
