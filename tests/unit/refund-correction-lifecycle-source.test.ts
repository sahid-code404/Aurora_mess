import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getNotificationTargetRoute } from "@/lib/notification-routes";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const schema = source("prisma/schema.prisma");
const migration = source("prisma/migrations/20260906_070000_add_refund_correction_lifecycle/migration.sql");
const correction = source("src/lib/domain/refund-correction.ts");
const funds = source("src/lib/domain/funds.ts");
const ledger = source("src/lib/domain/ledger.ts");
const adminRefunds = source("src/app/api/v1/admin/refunds/route.ts");
const voidRoute = source("src/app/api/v1/admin/refunds/[id]/void/route.ts");
const adminPayments = source("src/components/app/admin/payments.tsx");
const residentPayments = source("src/components/app/resident/payments.tsx");
const residentTypes = source("src/components/app/resident/_shared/types.ts");

describe("refund correction lifecycle source contracts", () => {
  test("Refund persistence has explicit correction provenance and cannot default into a dead PENDING state", () => {
    const refundModel = schema.slice(schema.indexOf("model Refund {"), schema.indexOf("model ExpenseCategory"));
    expect(refundModel).toContain("status            String // COMPLETED | VOIDED");
    expect(refundModel).not.toContain('@default("PENDING")');
    expect(refundModel).toContain("reversalJournalId String?");
    expect(refundModel).toContain("voidReason        String?");
    expect(refundModel).toContain("voidedByUserId    String?");
    expect(refundModel).toContain("voidedAt          DateTime?");
    expect(refundModel).toContain("@@index([institutionId, residentId, status])");

    expect(migration).toContain('ALTER COLUMN "status" DROP DEFAULT');
    expect(migration).toContain('ADD COLUMN "reversalJournalId" TEXT');
    expect(migration).toContain('ADD COLUMN "voidReason" TEXT');
    expect(migration).toContain('CREATE INDEX "Refund_institutionId_residentId_status_idx"');
  });

  test("cash refund correction locks resident first, verifies the original journal, mirrors it, then guards COMPLETED to VOIDED", () => {
    const transaction = correction.indexOf("return db.$transaction(async (tx) => {");
    const lock = correction.indexOf("await lockResidentFinancialMutation(", transaction);
    const freshRead = correction.indexOf("const refund = await tx.refund.findFirst(", transaction);
    const journalRead = correction.indexOf("const originalJournal = await tx.ledgerJournal.findFirst(", freshRead);
    const reversalPost = correction.indexOf("const reversal = await postJournal(", journalRead);
    const journalGuard = correction.indexOf("const journalGuard = await tx.ledgerJournal.updateMany(", reversalPost);
    const refundGuard = correction.indexOf("const guard = await tx.refund.updateMany(", journalGuard);
    const settlement = correction.indexOf("await recomputeBillSettlement(tx, refund.residentId)", refundGuard);
    const audit = correction.indexOf("await appendAudit(", settlement);
    const outbox = correction.indexOf("await appendOutbox(", audit);

    expect(transaction).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(transaction);
    expect(lock).toBeLessThan(freshRead);
    expect(freshRead).toBeLessThan(journalRead);
    expect(journalRead).toBeLessThan(reversalPost);
    expect(reversalPost).toBeLessThan(journalGuard);
    expect(journalGuard).toBeLessThan(refundGuard);
    expect(refundGuard).toBeLessThan(settlement);
    expect(settlement).toBeLessThan(audit);
    expect(audit).toBeLessThan(outbox);

    expect(correction).toContain('{ accountCode: "CASH", debitMinor: refund.amountMinor }');
    expect(correction).toContain('{ accountCode: "RESIDENT_FUNDS", creditMinor: refund.amountMinor }');
    expect(correction).toContain('data: { status: "REVERSED", reversedByJournalId: reversalJournalId }');
    expect(correction).toContain('where: { id: refund.id, status: "COMPLETED" }');
    expect(correction).toContain('status: "VOIDED"');
    expect(correction).toContain("refund.reversalJournalId || refund.voidReason || refund.voidedByUserId || refund.voidedAt");
  });

  test("carry-forward correction never invents ledger movement", () => {
    expect(correction).toContain('} else if (refund.mode === "CARRY_FORWARD") {');
    expect(correction).toContain("if (refund.journalId || refund.reversalJournalId)");
    expect(correction).toContain("This carry-forward unexpectedly has a journal and cannot be voided safely.");
  });

  test("FIFO settlement uses spendable approved cash after completed cash refunds", () => {
    expect(funds).toContain('where: { residentId, status: "APPROVED" }');
    expect(funds).toContain('where: { residentId, status: "COMPLETED", mode: "ISSUE_REFUND" }');
    expect(funds).toContain("const poolMinor = Math.max(0, approvedMinor - completedCashRefundMinor);");
    expect(funds).toContain("carry-forward never removes cash and therefore does not reduce this pool");
  });

  test("reconciliation validates completed and voided refund journal chains without weakening bill journals", () => {
    expect(ledger).toContain('where: { institutionId, status: { in: ["POSTED", "REVERSED"] } }');
    expect(ledger).toContain('const expectedOriginalStatus = refund.status === "VOIDED" ? "REVERSED" : "POSTED";');
    expect(ledger).toContain("originalJournal.reversedByJournalId !== refund.reversalJournalId");
    expect(ledger).toContain('!linkedJournalMatches(reversalJournal, institutionId, "REFUND", refund.id)');
    expect(ledger).toContain('refund.status !== "COMPLETED" && refund.status !== "VOIDED"');
    expect(ledger).toContain('journal.status === "POSTED" && journal.refType === "BILL"');
    expect(ledger).toContain("refundInvalidLifecycleRows");
  });

  test("Admin exposes a reason-required correction action while Resident history explains voided records", () => {
    expect(voidRoute).toContain('route({ auth: "ADMIN" }');
    expect(voidRoute).toContain("reasonSchema");
    expect(voidRoute).toContain("await voidRefund({");
    expect(adminPayments).toContain('postJson(`/api/v1/admin/refunds/${refundVoidTarget.id}/void`, { reason })');
    expect(adminPayments).toContain("requireReason");
    expect(adminPayments).toContain('ref.status === "COMPLETED"');
    expect(adminPayments).toContain('`Corrected: ${ref.voidReason ?? "Administrative correction"}`');
    expect(residentPayments).toContain('r.status === "VOIDED"');
    expect(residentPayments).toContain('`Corrected: ${r.voidReason ?? "Administrative correction"}`');
    expect(residentTypes).toContain('status: "COMPLETED" | "VOIDED" | string;');
    expect(residentTypes).toContain("voidReason: string | null;");
  });

  test("Refund History no longer prioritizes transaction-internal PENDING/PROCESSING states", () => {
    expect(adminRefunds).toContain("const sortedItems = page.items;");
    expect(adminRefunds).not.toContain('status === "PENDING" || status === "PROCESSING"');
  });

  test("REFUND_VOIDED notifications route back to the real correction history for both roles", () => {
    expect(getNotificationTargetRoute("REFUND_VOIDED", "ADMIN", "refund-id")).toBe(
      "#/admin/payments/refunds"
    );
    expect(getNotificationTargetRoute("REFUND_VOIDED", "RESIDENT", "refund-id")).toBe(
      "#/app/payments"
    );
  });
});
