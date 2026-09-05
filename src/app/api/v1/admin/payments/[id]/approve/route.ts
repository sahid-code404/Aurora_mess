/**
 * POST /api/v1/admin/payments/[id]/approve — approve a PENDING payment (auth ADMIN).
 * Transaction: resident financial lock → row-status guard → journal
 * Dr CASH / Cr RESIDENT_FUNDS → settle the resident's open bills FIFO
 * (paymentsMinor/totalDueMinor/status updated so bills actually close —
 * audit 9-a #5 / 9-c #5) → status history → audit → outbox notification.
 * Funds become available only after this approval (PENDING adds nothing).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement } from "@/lib/domain/funds";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";
import { serializePayment } from "@/lib/domain/serialize";
import { resolveNotificationsForEntity } from "@/lib/domain/notify";

export const dynamic = "force-dynamic";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const payload = await db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: ctx.params.id, institutionId: ctx.institutionId } });
    if (!payment) throw new ApiError(CODES.NOT_FOUND, "Payment not found.", 404);
    if (payment.status !== "PENDING") {
      throw new ApiError(CODES.PAYMENT_ALREADY_REVIEWED, "This payment was already reviewed.", 409);
    }

    // All settlement-changing writes for one resident share this stable row lock.
    // A concurrent approval/void/adjustment must commit first, then this
    // transaction's FIFO recompute sees that committed transition as well.
    await lockResidentFinancialMutation(tx, ctx.institutionId, payment.residentId);

    // Concurrency guard: only one transition from PENDING can succeed.
    const guard = await tx.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewedByUserId: ctx.user.id },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.PAYMENT_ALREADY_REVIEWED, "This payment was already reviewed.", 409);
    }

    // Double-entry: money enters CASH and is held on behalf of the resident.
    const { journalId } = await postJournal(
      {
        institutionId: ctx.institutionId,
        refType: "PAYMENT",
        refId: payment.id,
        description: `Payment ${payment.displayNumber} approved`,
        createdByUserId: ctx.user.id,
        lines: [
          { accountCode: "CASH", debitMinor: payment.amountMinor },
          { accountCode: "RESIDENT_FUNDS", creditMinor: payment.amountMinor },
        ],
      },
      tx
    );

    await tx.payment.update({ where: { id: payment.id }, data: { approvedJournalId: journalId } });

    // Settle bills: recompute the resident's whole bill allocation from the
    // approved-payment pool (FIFO, oldest due first) so "amount to pay"
    // actually shrinks and bills reach PARTIALLY_PAID / PAID / OVERDUE.
    // Read-model only — the money journals were already posted above and at
    // bill generation.
    const settlement = await recomputeBillSettlement(tx, payment.residentId);

    await tx.paymentStatusHistory.create({
      data: {
        paymentId: payment.id,
        fromStatus: "PENDING",
        toStatus: "APPROVED",
        changedByUserId: ctx.user.id,
      },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "PAYMENT_APPROVED",
        entityType: "PAYMENT",
        entityId: payment.id,
        requestId: ctx.requestId,
        beforeSummary: "PENDING",
        afterSummary: "APPROVED",
        metadata: {
          amountMinor: payment.amountMinor,
          displayNumber: payment.displayNumber,
          residentId: payment.residentId,
          journalId,
          settledBills: settlement.changedBills,
          unappliedMinor: settlement.unappliedMinor,
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
        type: "PAYMENT_APPROVED",
        title: "Payment approved",
        message:
          settlement.changedBills.length > 0
            ? `Your payment of ${formatMinor(payment.amountMinor)} (${payment.displayNumber}) was approved and applied to ${settlement.changedBills.length} bill${settlement.changedBills.length === 1 ? "" : "s"}.`
            : `Your payment of ${formatMinor(payment.amountMinor)} (${payment.displayNumber}) was approved.`,
        entityRef: payment.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: payment.id,
      types: ["PAYMENT_SUBMITTED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason: `Payment ${payment.displayNumber} approved by admin`,
      client: tx,
    });

    return serializePayment({ ...payment, status: "APPROVED", approvedJournalId: journalId });
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
