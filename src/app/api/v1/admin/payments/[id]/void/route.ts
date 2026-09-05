/**
 * POST /api/v1/admin/payments/[id]/void — void an APPROVED payment (auth ADMIN).
 * Posts the reversal journal (Dr RESIDENT_FUNDS / Cr CASH) and REVERSES the
 * bill settlement the approval applied (un-apply FIFO mirror) atomically with
 * the status change; approved payments are never edited or deleted (spec §39).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { reasonSchema } from "@/lib/validation";
import { postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement } from "@/lib/domain/funds";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";
import { serializePayment } from "@/lib/domain/serialize";
import { resolveNotificationsForEntity } from "@/lib/domain/notify";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const payload = await db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: ctx.params.id, institutionId: ctx.institutionId } });
    if (!payment) throw new ApiError(CODES.NOT_FOUND, "Payment not found.", 404);
    if (payment.status === "VOIDED") {
      throw new ApiError(CODES.PAYMENT_INVALID_STATE, "This payment was already voided.", 409);
    }
    if (payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") {
      throw new ApiError(
        CODES.PAYMENT_INVALID_STATE,
        "Refunded payments cannot be voided — issue a correcting refund instead.",
        409
      );
    }
    if (payment.status !== "APPROVED") {
      throw new ApiError(CODES.PAYMENT_INVALID_STATE, "Only approved payments can be voided.", 409);
    }

    // Serialize the resident's entire settlement mutation before changing the
    // payment status. A concurrent approval/void/adjustment must commit first.
    await lockResidentFinancialMutation(tx, ctx.institutionId, payment.residentId);

    const guard = await tx.payment.updateMany({
      where: { id: payment.id, status: "APPROVED" },
      data: { status: "VOIDED", reviewedAt: new Date(), reviewedByUserId: ctx.user.id },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.PAYMENT_INVALID_STATE, "This payment was already voided.", 409);
    }

    // Reversal journal — the money leaves the books the same way it entered.
    const { journalId } = await postJournal(
      {
        institutionId: ctx.institutionId,
        refType: "PAYMENT",
        refId: payment.id,
        description: `Payment ${payment.displayNumber} voided`,
        createdByUserId: ctx.user.id,
        lines: [
          { accountCode: "RESIDENT_FUNDS", debitMinor: payment.amountMinor },
          { accountCode: "CASH", creditMinor: payment.amountMinor },
        ],
      },
      tx
    );

    await tx.payment.update({ where: { id: payment.id }, data: { voidJournalId: journalId } });

    // Reverse the bill settlement this payment participated in: recompute the
    // allocation from the remaining approved-payment pool (the voided payment
    // is excluded) — deterministic FIFO, no attribution drift.
    const reversal = await recomputeBillSettlement(tx, payment.residentId);

    await tx.paymentStatusHistory.create({
      data: {
        paymentId: payment.id,
        fromStatus: "APPROVED",
        toStatus: "VOIDED",
        changedByUserId: ctx.user.id,
        reason: body.reason,
      },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "PAYMENT_VOIDED",
        entityType: "PAYMENT",
        entityId: payment.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: "APPROVED",
        afterSummary: "VOIDED",
        metadata: {
          amountMinor: payment.amountMinor,
          displayNumber: payment.displayNumber,
          residentId: payment.residentId,
          reversalJournalId: journalId,
          reversedBills: reversal.changedBills,
          unappliedMinor: reversal.unappliedMinor,
        },
      },
      tx
    );

    await appendOutbox(
      ctx.institutionId,
      "NOTIFICATION",
      {
        userId: payment.residentId,
        institutionId: ctx.institutionId,
        type: "PAYMENT_VOIDED",
        title: "Payment voided",
        message: `Your payment of ${formatMinor(payment.amountMinor)} (${payment.displayNumber}) was voided — ${body.reason}`,
        entityRef: payment.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: payment.id,
      types: ["PAYMENT_SUBMITTED", "PAYMENT_APPROVED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason: `Payment ${payment.displayNumber} voided by admin: ${body.reason}`,
      client: tx,
    });

    return serializePayment({ ...payment, status: "VOIDED", voidJournalId: journalId });
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
