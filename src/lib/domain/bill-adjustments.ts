import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement } from "@/lib/domain/funds";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";

export type CreateBillAdjustmentInput = {
  institutionId: string;
  billId: string;
  amountMinor: number;
  reason: string;
  adminUserId: string;
  requestId: string;
};

/**
 * Apply one immutable historical bill correction without allowing concurrent
 * admins to race a stale `adjustmentsMinor` read.
 *
 * Lock order is always resident → bill. The resident row serializes every FIFO
 * settlement mutation across all of that resident's payments and bills; the
 * Bill row then protects this bill's adjustment aggregate. Reversing that order
 * could deadlock two adjustments on different bills when settlement recomputes
 * the resident's complete bill set.
 */
export async function createBillAdjustment(input: CreateBillAdjustmentInput) {
  return db.$transaction(async (tx) => {
    // The owner identity is used only to acquire the stable resident mutex. The
    // Bill is revalidated under its own row lock immediately afterwards.
    const identity = await tx.bill.findFirst({
      where: { id: input.billId, institutionId: input.institutionId },
      select: { id: true, residentId: true },
    });
    if (!identity) {
      throw new ApiError(CODES.NOT_FOUND, "Bill not found.", 404);
    }

    await lockResidentFinancialMutation(tx, input.institutionId, identity.residentId);

    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Bill"
      WHERE "id" = ${input.billId}
        AND "institutionId" = ${input.institutionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      throw new ApiError(CODES.NOT_FOUND, "Bill not found.", 404);
    }

    // Re-read only after both locks. This is the current aggregate, never the
    // stale pre-lock version that allowed concurrent lost updates.
    const bill = await tx.bill.findUnique({
      where: { id: input.billId },
      include: {
        period: { select: { id: true, year: true, month: true, status: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (
      !bill ||
      bill.institutionId !== input.institutionId ||
      bill.residentId !== identity.residentId
    ) {
      throw new ApiError(CODES.NOT_FOUND, "Bill not found.", 404);
    }
    if (bill.status === "VOIDED") {
      throw new ApiError("BILL_INVALID_STATE", "Voided bills cannot be adjusted.", 409);
    }
    if (!["BILLED", "REOPENED"].includes(bill.period.status)) {
      throw new ApiError("BILL_INVALID_STATE", "Only generated historical bills can be adjusted.", 409);
    }

    const newAdjustmentsMinor = bill.adjustmentsMinor + input.amountMinor;
    const newEffectiveCharge = bill.subtotalMinor + newAdjustmentsMinor;
    if (newEffectiveCharge < 0) {
      const maximumCreditMinor = Math.max(0, bill.subtotalMinor + bill.adjustmentsMinor);
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "A bill credit cannot reduce the billed charge below zero.",
        422,
        { amount: `The largest credit available on this bill is ${formatMinor(maximumCreditMinor)}.` }
      );
    }

    const adjustment = await tx.billAdjustment.create({
      data: {
        billId: bill.id,
        amountMinor: input.amountMinor,
        reason: input.reason,
        createdByUserId: input.adminUserId,
      },
    });

    await tx.bill.update({
      where: { id: bill.id },
      data: { adjustmentsMinor: newAdjustmentsMinor },
    });

    const journal = await postJournal(
      {
        institutionId: input.institutionId,
        description: `Bill adjustment ${bill.billNumber} — ${input.reason}`,
        refType: "BILL_ADJUSTMENT",
        refId: adjustment.id,
        createdByUserId: input.adminUserId,
        lines:
          input.amountMinor > 0
            ? [
                { accountCode: "RESIDENT_FUNDS", debitMinor: input.amountMinor },
                { accountCode: "MEAL_CHARGE_INCOME", creditMinor: input.amountMinor },
              ]
            : [
                { accountCode: "MEAL_CHARGE_INCOME", debitMinor: Math.abs(input.amountMinor) },
                { accountCode: "RESIDENT_FUNDS", creditMinor: Math.abs(input.amountMinor) },
              ],
      },
      tx
    );

    await recomputeBillSettlement(tx, bill.residentId);

    const updated = await tx.bill.findUniqueOrThrow({
      where: { id: bill.id },
      include: {
        period: { select: { id: true, year: true, month: true, status: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "BILL_ADJUSTED",
        entityType: "BILL",
        entityId: bill.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: `charge ${formatMinor(Math.max(0, bill.subtotalMinor + bill.adjustmentsMinor))} · due ${formatMinor(bill.totalDueMinor)}`,
        afterSummary: `charge ${formatMinor(newEffectiveCharge)} · due ${formatMinor(updated.totalDueMinor)}`,
        metadata: {
          amountMinor: input.amountMinor,
          billNumber: bill.billNumber,
          residentId: bill.residentId,
          adjustmentsMinor: newAdjustmentsMinor,
          newTotalDueMinor: updated.totalDueMinor,
          journalId: journal.journalId,
          settlementStatus: updated.status,
        },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: bill.residentId,
        institutionId: input.institutionId,
        type: "BILL_ADJUSTED",
        title: "Bill adjusted",
        message: `Your bill ${bill.billNumber} was adjusted by ${formatMinor(input.amountMinor)} — ${input.reason}`,
        entityRef: bill.id,
      },
      tx
    );

    return {
      bill: updated,
      adjustment: {
        id: adjustment.id,
        billId: bill.id,
        amountMinor: adjustment.amountMinor,
        reason: adjustment.reason,
        createdAt: adjustment.createdAt,
        journalId: journal.journalId,
      },
    };
  });
}
