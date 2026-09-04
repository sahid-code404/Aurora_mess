/**
 * POST /api/v1/admin/bills/[id]/adjustment — correct a closed-period bill
 * (auth ADMIN, spec §59): {amount (decimal string, may be negative), reason}.
 * Creates an immutable BillAdjustment, updates the bill's totals and status,
 * notifies the resident. totalDue clamps at zero (credits beyond zero live in
 * the adjustment rows; the funds read model is unchanged — documented).
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
      include: { period: { select: { id: true, year: true, month: true, status: true } }, lines: { orderBy: { sortOrder: "asc" } } },
    });
    if (!bill) throw new ApiError(CODES.NOT_FOUND, "Bill not found.", 404);
    if (bill.status === "VOIDED") {
      throw new ApiError("BILL_INVALID_STATE", "Voided bills cannot be adjusted.", 409);
    }

    const newAdjustmentsMinor = bill.adjustmentsMinor + amountMinor;
    const newTotalDue = Math.max(0, bill.totalDueMinor + amountMinor);
    let newStatus: string;
    if (newTotalDue <= 0) {
      newStatus = "PAID";
    } else if (bill.paymentsMinor > 0) {
      newStatus = "PARTIALLY_PAID";
    } else {
      newStatus = bill.status === "OVERDUE" || bill.dueDate < new Date() ? "OVERDUE" : "GENERATED";
    }

    const adjustment = await tx.billAdjustment.create({
      data: {
        billId: bill.id,
        amountMinor,
        reason: body.reason,
        createdByUserId: ctx.user.id,
      },
    });

    const updated = await tx.bill.update({
      where: { id: bill.id },
      data: {
        adjustmentsMinor: newAdjustmentsMinor,
        totalDueMinor: newTotalDue,
        status: newStatus,
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
        beforeSummary: `totalDue ${formatMinor(bill.totalDueMinor)}`,
        afterSummary: `totalDue ${formatMinor(newTotalDue)}`,
        metadata: {
          amountMinor,
          billNumber: bill.billNumber,
          residentId: bill.residentId,
          newTotalDueMinor: newTotalDue,
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
      bill: serializeBill({ ...updated, period: bill.period, lines: bill.lines }),
      adjustment: {
        id: adjustment.id,
        billId: bill.id,
        amountMinor: adjustment.amountMinor,
        amountFormatted: formatMinor(adjustment.amountMinor),
        reason: adjustment.reason,
        createdAt: adjustment.createdAt.toISOString(),
      },
    };
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
