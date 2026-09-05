/**
 * POST /api/v1/admin/bills/[id]/adjustment — correct a generated historical bill
 * (auth ADMIN, spec §59): {amount (decimal string, may be negative), reason}.
 * Creates an immutable BillAdjustment, posts the matching correction journal,
 * and recomputes FIFO bill settlement so funds, bill status and ledger stay in sync.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { formatMinor, parseDecimalToMinor } from "@/lib/money";
import { reasonSchema } from "@/lib/validation";
import { serializeBill } from "@/lib/domain/serialize";
import { postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement } from "@/lib/domain/funds";

export const dynamic = "force-dynamic";

const MAX_ADJUSTMENT_MINOR = 100_000_000;

const bodySchema = z.object({
  amount: z.string().min(1, "Enter an adjustment amount."),
  reason: reasonSchema,
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const amountMinor = parseDecimalToMinor(body.amount);
  if (amountMinor === null || amountMinor === 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Enter a non-zero adjustment amount.", 400, {
      amount: "Enter a non-zero adjustment amount.",
    });
  }
  if (Math.abs(amountMinor) > MAX_ADJUSTMENT_MINOR) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Adjustments up to ₹10,00,000.00 are supported.", 400, {
      amount: "Adjustments up to ₹10,00,000.00 are supported.",
    });
  }

  const payload = await db.$transaction(async (tx) => {
    const bill = await tx.bill.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
      include: {
        period: { select: { id: true, year: true, month: true, status: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!bill) throw new ApiError(CODES.NOT_FOUND, "Bill not found.", 404);
    if (bill.status === "VOIDED") {
      throw new ApiError("BILL_INVALID_STATE", "Voided bills cannot be adjusted.", 409);
    }
    if (!['BILLED', 'REOPENED'].includes(bill.period.status)) {
      throw new ApiError("BILL_INVALID_STATE", "Only generated historical bills can be adjusted.", 409);
    }

    const newAdjustmentsMinor = bill.adjustmentsMinor + amountMinor;
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
        amountMinor,
        reason: body.reason,
        createdByUserId: ctx.user.id,
      },
    });

    await tx.bill.update({
      where: { id: bill.id },
      data: { adjustmentsMinor: newAdjustmentsMinor },
    });

    const journal = await postJournal(
      {
        institutionId: ctx.institutionId,
        description: `Bill adjustment ${bill.billNumber} — ${body.reason}`,
        refType: "BILL_ADJUSTMENT",
        refId: adjustment.id,
        createdByUserId: ctx.user.id,
        lines:
          amountMinor > 0
            ? [
                { accountCode: "RESIDENT_FUNDS", debitMinor: amountMinor },
                { accountCode: "MEAL_CHARGE_INCOME", creditMinor: amountMinor },
              ]
            : [
                { accountCode: "MEAL_CHARGE_INCOME", debitMinor: Math.abs(amountMinor) },
                { accountCode: "RESIDENT_FUNDS", creditMinor: Math.abs(amountMinor) },
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
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "BILL_ADJUSTED",
        entityType: "BILL",
        entityId: bill.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: `charge ${formatMinor(Math.max(0, bill.subtotalMinor + bill.adjustmentsMinor))} · due ${formatMinor(bill.totalDueMinor)}`,
        afterSummary: `charge ${formatMinor(newEffectiveCharge)} · due ${formatMinor(updated.totalDueMinor)}`,
        metadata: {
          amountMinor,
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
      ctx.institutionId,
      "NOTIFICATION",
      {
        userId: bill.residentId,
        institutionId: ctx.institutionId,
        type: "BILL_ADJUSTED",
        title: "Bill adjusted",
        message: `Your bill ${bill.billNumber} was adjusted by ${formatMinor(amountMinor)} — ${body.reason}`,
        entityRef: bill.id,
      },
      tx
    );

    return {
      bill: serializeBill(updated),
      adjustment: {
        id: adjustment.id,
        billId: bill.id,
        amountMinor: adjustment.amountMinor,
        amountFormatted: formatMinor(adjustment.amountMinor),
        reason: adjustment.reason,
        createdAt: adjustment.createdAt.toISOString(),
        journalId: journal.journalId,
      },
    };
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
