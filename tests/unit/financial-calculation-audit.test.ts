import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { summarizeResidentFinancialGroups } from "@/lib/domain/institution-financial-totals";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("financial calculation audit contracts", () => {
  test("resident credits and deficits never net across residents", () => {
    const totals = summarizeResidentFinancialGroups(
      [
        { residentId: "resident-a", _sum: { amountMinor: 200_000 } },
        { residentId: "resident-b", _sum: { amountMinor: 100_000 } },
      ],
      [
        {
          residentId: "resident-a",
          _sum: { subtotalMinor: 150_000, adjustmentsMinor: 0, totalDueMinor: 0 },
        },
        {
          residentId: "resident-b",
          _sum: { subtotalMinor: 150_000, adjustmentsMinor: 0, totalDueMinor: 50_000 },
        },
      ],
      []
    );

    expect(totals.residentCreditLiabilityMinor).toBe(50_000);
    expect(totals.residentDeficitMinor).toBe(50_000);
    expect(totals.outstandingBillsMinor).toBe(50_000);
    expect(totals.netResidentFundsMinor).toBe(0);
  });

  test("completed cash refunds reduce credit while carry-forward is excluded from cash-refund groups", () => {
    const totals = summarizeResidentFinancialGroups(
      [{ residentId: "resident-a", _sum: { amountMinor: 200_000 } }],
      [
        {
          residentId: "resident-a",
          _sum: { subtotalMinor: 150_000, adjustmentsMinor: 0, totalDueMinor: 0 },
        },
      ],
      [{ residentId: "resident-a", _sum: { amountMinor: 20_000 } }]
    );

    expect(totals.residentCreditLiabilityMinor).toBe(30_000);
    expect(totals.completedCashRefundsMinor).toBe(20_000);
  });

  test("formula funds use ledger cash and preserve resident liabilities separately", () => {
    const text = source("src/lib/domain/formula/providers/funds.ts");
    expect(text).toContain("getAccountBalances(institutionId, client)");
    expect(text).toContain("const availableFunds = Math.max(0, cashBalance)");
    expect(text).toContain("const totalDeficit = Math.max(0, -cashBalance)");
    expect(text).toContain("residentTotals.residentCreditLiabilityMinor");
    expect(text).not.toContain("cashBalance > 0 ? cashBalance : netResidentFunds");
  });

  test("payment variables treat approved receipts as deposits and cash refunds only as refunds", () => {
    const text = source("src/lib/domain/formula/providers/payment.ts");
    expect(text).not.toContain('method: "DEPOSIT"');
    expect(text).toContain("total_deposits: approved");
    expect(text).toContain('mode: "ISSUE_REFUND"');
    expect(text).toContain('code: "RESIDENT_FUNDS"');
  });

  test("market expense never falls back to unrelated approved expenses", () => {
    const text = source("src/lib/domain/formula/providers/expense.ts");
    expect(text).toContain("const marketTotal = marketAgg._sum.totalMinor ?? 0");
    expect(text).toContain("total_expense: approvedTotal");
    expect(text).not.toContain("fall back to approved total");
  });

  test("formula meal confirmation uses authoritative lockAt exactly like billing", () => {
    const provider = source("src/lib/domain/formula/providers/meal.ts");
    const billing = source("src/lib/domain/billing.ts");
    expect(provider).toContain("mealInstance: { lockAt: { lte: now } }");
    expect(provider).not.toContain("mealInstance: { cutoffAt: { lte: now } }");
    expect(billing).toContain("mealInstance: { lockAt: { lte: now } }");
  });

  test("admin financial KPIs are not computed from the first 200 resident credits", () => {
    const dashboard = source("src/app/api/v1/admin/dashboard/route.ts");
    const funds = source("src/app/api/v1/admin/funds/route.ts");
    expect(dashboard).toContain('account.code === "CASH"');
    expect(dashboard).toContain("db.user.count");
    expect(dashboard).not.toContain("residentFundsSummary");
    expect(funds).toContain("institutionResidentFinancialTotals(ctx.institutionId)");
    expect(funds).toContain("const availableFundsTotal = Math.max(0, cashBalance)");
    expect(funds).toContain("residentCount: activeResidentCount");
  });

  test("cash-refund APIs explicitly exclude carry-forward from refund money totals", () => {
    for (const path of [
      "src/app/api/v1/refunds/route.ts",
      "src/app/api/v1/admin/refunds/route.ts",
      "src/app/api/v1/admin/payments/route.ts",
    ]) {
      const text = source(path);
      expect(text).toContain('mode: "ISSUE_REFUND"');
      expect(text).toContain('mode: "CARRY_FORWARD"');
    }
  });
});
