/**
 * POST /api/v1/admin/refunds/[id]/void — correct a completed refund without
 * deleting financial history. Cash payouts require a compensating journal;
 * carry-forward corrections are non-ledger state changes.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { voidRefund } from "@/lib/domain/refund-correction";
import { serializeRefund } from "@/lib/domain/serialize";
import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const refund = await voidRefund({
    institutionId: ctx.institutionId,
    refundId: ctx.params.id,
    reason: body.reason,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
  });

  sweepOutbox(20).catch(() => {});
  return { data: serializeRefund(refund) };
});
