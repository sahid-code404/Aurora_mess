/**
 * POST /api/v1/admin/payments/[id]/reject — reject a PENDING payment (auth ADMIN).
 * Requires a reason (shown to the resident). No journal: rejected money never
 * entered the books.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { reasonSchema } from "@/lib/validation";
import { serializePayment } from "@/lib/domain/serialize";
import { resolveNotificationsForEntity } from "@/lib/domain/notify";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const payload = await db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: ctx.params.id, institutionId: ctx.institutionId } });
    if (!payment) throw new ApiError(CODES.NOT_FOUND, "Payment not found.", 404);
    if (payment.status !== "PENDING") {
      throw new ApiError(CODES.PAYMENT_ALREADY_REVIEWED, "This payment was already reviewed.", 409);
    }

    const guard = await tx.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedByUserId: ctx.user.id,
        rejectionReason: body.reason,
      },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.PAYMENT_ALREADY_REVIEWED, "This payment was already reviewed.", 409);
    }

    await tx.paymentStatusHistory.create({
      data: {
        paymentId: payment.id,
        fromStatus: "PENDING",
        toStatus: "REJECTED",
        changedByUserId: ctx.user.id,
        reason: body.reason,
      },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "PAYMENT_REJECTED",
        entityType: "PAYMENT",
        entityId: payment.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: "PENDING",
        afterSummary: "REJECTED",
        metadata: { amountMinor: payment.amountMinor, displayNumber: payment.displayNumber, residentId: payment.residentId },
      },
      tx
    );

    await appendOutbox(
      ctx.institutionId,
      "NOTIFICATION",
      {
        userId: payment.residentId,
        institutionId: ctx.institutionId,
        type: "PAYMENT_REJECTED",
        title: "Payment could not be verified",
        message: `Your payment of ${formatMinor(payment.amountMinor)} (${payment.displayNumber}) was rejected — ${body.reason}`,
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
      reason: `Payment ${payment.displayNumber} rejected by admin: ${body.reason}`,
      client: tx,
    });

    return serializePayment({ ...payment, status: "REJECTED", rejectionReason: body.reason });
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
