import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement } from "@/lib/domain/funds";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";

export type VoidRefundInput = {
  institutionId: string;
  refundId: string;
  reason: string;
  actorUserId: string;
  requestId: string;
};

/**
 * Void one completed refund without deleting or rewriting financial history.
 *
 * ISSUE_REFUND:
 *   COMPLETED -> VOIDED and the original Dr RESIDENT_FUNDS / Cr CASH journal is
 *   mirrored by Dr CASH / Cr RESIDENT_FUNDS. The original journal is marked
 *   REVERSED and points at the compensating journal.
 *
 * CARRY_FORWARD:
 *   COMPLETED -> VOIDED with no journal. This re-opens the latest bill cycle's
 *   refund decision because eligibility only treats COMPLETED carry-forward
 *   rows as resolved.
 *
 * The resident row is the lifecycle mutex. Refund creation, payment settlement
 * and billing use the same resident boundary, so the fresh read after this lock
 * is authoritative under PostgreSQL READ COMMITTED.
 */
export async function voidRefund(input: VoidRefundInput) {
  const owner = await db.refund.findFirst({
    where: { id: input.refundId, institutionId: input.institutionId },
    select: { residentId: true },
  });
  if (!owner) throw new ApiError(CODES.NOT_FOUND, "Refund not found.", 404);

  return db.$transaction(async (tx) => {
    await lockResidentFinancialMutation(tx, input.institutionId, owner.residentId);

    const refund = await tx.refund.findFirst({
      where: { id: input.refundId, institutionId: input.institutionId },
    });
    if (!refund) throw new ApiError(CODES.NOT_FOUND, "Refund not found.", 404);
    if (refund.status === "VOIDED") {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "This refund was already voided.", 409);
    }
    if (refund.status !== "COMPLETED") {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "Only completed refunds can be voided.", 409);
    }

    let reversalJournalId: string | null = null;
    if (refund.mode === "ISSUE_REFUND") {
      if (!refund.journalId) {
        throw new ApiError(
          CODES.RESOURCE_CHANGED,
          "This cash refund has no original journal and cannot be reversed safely.",
          409
        );
      }

      const originalJournal = await tx.ledgerJournal.findFirst({
        where: { id: refund.journalId, institutionId: input.institutionId },
        include: { entries: { include: { account: { select: { code: true } } } } },
      });
      const legacyRefMatches =
        originalJournal?.refId == null ||
        (refund.paymentId != null && originalJournal?.refId === refund.paymentId);
      const referenceMatches = originalJournal?.refId === refund.id || legacyRefMatches;
      const residentFundsDebit =
        originalJournal?.entries
          .filter((entry) => entry.account.code === "RESIDENT_FUNDS")
          .reduce((sum, entry) => sum + entry.debitMinor, 0) ?? 0;
      const residentFundsCredit =
        originalJournal?.entries
          .filter((entry) => entry.account.code === "RESIDENT_FUNDS")
          .reduce((sum, entry) => sum + entry.creditMinor, 0) ?? 0;
      const cashDebit =
        originalJournal?.entries
          .filter((entry) => entry.account.code === "CASH")
          .reduce((sum, entry) => sum + entry.debitMinor, 0) ?? 0;
      const cashCredit =
        originalJournal?.entries
          .filter((entry) => entry.account.code === "CASH")
          .reduce((sum, entry) => sum + entry.creditMinor, 0) ?? 0;
      const totalDebit = originalJournal?.entries.reduce((sum, entry) => sum + entry.debitMinor, 0) ?? 0;
      const totalCredit = originalJournal?.entries.reduce((sum, entry) => sum + entry.creditMinor, 0) ?? 0;

      if (
        !originalJournal ||
        originalJournal.status !== "POSTED" ||
        originalJournal.refType !== "REFUND" ||
        !referenceMatches ||
        totalDebit !== refund.amountMinor ||
        totalCredit !== refund.amountMinor ||
        residentFundsDebit !== refund.amountMinor ||
        residentFundsCredit !== 0 ||
        cashDebit !== 0 ||
        cashCredit !== refund.amountMinor
      ) {
        throw new ApiError(
          CODES.RESOURCE_CHANGED,
          "The original refund journal no longer matches this payout and cannot be reversed safely.",
          409
        );
      }

      const reversal = await postJournal(
        {
          institutionId: input.institutionId,
          refType: "REFUND",
          refId: refund.id,
          description: `Reversal — refund voided (${input.reason})`,
          createdByUserId: input.actorUserId,
          lines: [
            { accountCode: "CASH", debitMinor: refund.amountMinor },
            { accountCode: "RESIDENT_FUNDS", creditMinor: refund.amountMinor },
          ],
        },
        tx
      );
      reversalJournalId = reversal.journalId;

      const journalGuard = await tx.ledgerJournal.updateMany({
        where: { id: originalJournal.id, status: "POSTED", reversedByJournalId: null },
        data: { status: "REVERSED", reversedByJournalId: reversalJournalId },
      });
      if (journalGuard.count !== 1) {
        throw new ApiError(CODES.RESOURCE_CHANGED, "This refund journal was already reversed.", 409);
      }
    } else if (refund.mode === "CARRY_FORWARD") {
      if (refund.journalId) {
        throw new ApiError(
          CODES.RESOURCE_CHANGED,
          "This carry-forward unexpectedly has a journal and cannot be voided safely.",
          409
        );
      }
    } else {
      throw new ApiError(CODES.RESOURCE_CHANGED, "This refund mode is not supported for correction.", 409);
    }

    const now = new Date();
    const guard = await tx.refund.updateMany({
      where: { id: refund.id, status: "COMPLETED" },
      data: {
        status: "VOIDED",
        reversalJournalId,
        voidReason: input.reason,
        voidedByUserId: input.actorUserId,
        voidedAt: now,
      },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "This refund was already changed.", 409);
    }

    // A reversed cash payout restores resident credit. Re-run the same FIFO
    // settlement kernel used by payment mutations immediately so newer bills
    // cannot remain due while Funds already exposes the restored credit.
    const settlement =
      refund.mode === "ISSUE_REFUND"
        ? await recomputeBillSettlement(tx, refund.residentId)
        : { changedBills: 0, unappliedMinor: 0 };

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "REFUND_VOIDED",
        entityType: "REFUND",
        entityId: refund.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: JSON.stringify({ status: "COMPLETED", mode: refund.mode, amountMinor: refund.amountMinor }),
        afterSummary: JSON.stringify({ status: "VOIDED", reversalJournalId }),
        metadata: {
          residentId: refund.residentId,
          mode: refund.mode,
          amountMinor: refund.amountMinor,
          originalJournalId: refund.journalId,
          reversalJournalId,
          settledBills: settlement.changedBills,
          unappliedMinor: settlement.unappliedMinor,
        },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: refund.residentId,
        institutionId: input.institutionId,
        type: "REFUND_VOIDED",
        title: "Refund correction recorded",
        message:
          refund.mode === "ISSUE_REFUND"
            ? `A ${formatMinor(refund.amountMinor)} refund was voided and restored to your BoardOps credit. Reason: ${input.reason}`
            : `A ${formatMinor(refund.amountMinor)} carry-forward decision was voided. Reason: ${input.reason}`,
        entityRef: refund.id,
      },
      tx
    );

    return tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
  });
}
