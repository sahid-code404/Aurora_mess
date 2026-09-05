/**
 * POST /api/v1/admin/bills/[id]/adjustment — correct a generated historical bill
 * (auth ADMIN, spec §59): {amount (decimal string, may be negative), reason}.
 * Creates an immutable BillAdjustment, posts the matching correction journal,
 * and recomputes FIFO bill settlement so funds, bill status and ledger stay in sync.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { sweepOutbox } from "@/lib/outbox";
import { formatMinor, parseDecimalToMinor } from "@/lib/money";
import { reasonSchema } from "@/lib/validation";
import { serializeBill } from "@/lib/domain/serialize";
import { createBillAdjustment } from "@/lib/domain/bill-adjustments";

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

  const result = await createBillAdjustment({
    institutionId: ctx.institutionId,
    billId: ctx.params.id,
    amountMinor,
    reason: body.reason,
    adminUserId: ctx.user.id,
    requestId: ctx.requestId,
  });

  sweepOutbox(20).catch(() => {});

  return {
    data: {
      bill: serializeBill(result.bill),
      adjustment: {
        ...result.adjustment,
        amountFormatted: formatMinor(result.adjustment.amountMinor),
        createdAt: result.adjustment.createdAt.toISOString(),
      },
    },
  };
});
