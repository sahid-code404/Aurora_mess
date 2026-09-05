/**
 * POST /api/v1/payments/[id]/cancel — resident-owned payment lifecycle closure.
 *
 * Only the owning Resident may withdraw a PENDING payment. Pending payments
 * have not entered the ledger yet, so this transition creates no journal and
 * never changes bill settlement. The row-status update guard makes an Admin
 * review vs Resident withdrawal race deterministic: exactly one transition
 * wins and the loser receives RESOURCE_CHANGED instead of overwriting history.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { formatMinor } from "@/lib/money";
import { notifyAdmins, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";
import { serializePayment } from "@/lib/domain/serialize";

export const dynamic = "force-dynamic";

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  const payment = await db.payment.findFirst({
    where: {
      id: ctx.params.id,
      institutionId: ctx.institutionId,
      residentId: ctx.user.id,
    },
  });

  if (!payment) {
    throw new ApiError(CODES.NOT_FOUND, "This payment could not be found.", 404);
  }
  if (payment.status === "VOIDED") {
    throw new ApiError(CODES.PAYMENT_INVALID_STATE, "This payment is already withdrawn or voided.", 409);
  }
  if (payment.status !== "PENDING") {
    throw new ApiError(
      CODES.PAYMENT_INVALID_STATE,
      "Only payments that are still waiting for review can be withdrawn.",
      409
    );
  }

  const result = await db.$transaction(async (tx) => {
    const guard = await tx.payment.updateMany({
      where: {
        id: payment.id,
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        status: "PENDING",
      },
      data: {
        status: "VOIDED",
        reviewedAt: new Date(),
        reviewedByUserId: ctx.user.id,
      },
    });

    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This payment was reviewed or changed just now. Refresh to see its latest state.",
        409
      );
    }

    await tx.paymentStatusHistory.create({
      data: {
        paymentId: payment.id,
        fromStatus: "PENDING",
        toStatus: "VOIDED",
        changedByUserId: ctx.user.id,
        reason: "Withdrawn by resident before review",
      },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "PAYMENT_WITHDRAWN",
        entityType: "PAYMENT",
        entityId: payment.id,
        requestId: ctx.requestId,
        reason: "Withdrawn by resident before review",
        beforeSummary: JSON.stringify({ status: "PENDING" }),
        afterSummary: JSON.stringify({ status: "VOIDED" }),
        metadata: {
          amountMinor: payment.amountMinor,
          displayNumber: payment.displayNumber,
          method: payment.method,
          selfService: true,
          ledgerImpact: false,
        },
      },
      tx
    );

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "PAYMENT_WITHDRAWN",
        title: "Payment submission withdrawn",
        message: `${residentName} withdrew ${payment.displayNumber} (${formatMinor(payment.amountMinor)}) before review.`,
        entityRef: payment.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: payment.id,
      types: ["PAYMENT_SUBMITTED"],
      actorUserId: ctx.user.id,
      actorRole: "RESIDENT",
      reason: `Payment ${payment.displayNumber} withdrawn by resident before review`,
      client: tx,
    });

    const updated = await tx.payment.findUnique({ where: { id: payment.id } });
    if (!updated) throw new ApiError(CODES.NOT_FOUND, "This payment could not be found.", 404);
    return serializePayment(updated);
  });

  await sweepOutboxSafe();
  return { data: result };
});
