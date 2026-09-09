/**
 * POST /api/v1/admin/billing/periods/[id]/generate — explicitly publish billing
 * (auth ADMIN). Body: {a, b, answer} — the human confirmation echo of the
 * readiness challenge (answer must equal a + b).
 *
 * Publication is blocked until the institution's configured publication date.
 * The domain transaction then re-runs readiness before freezing the immutable
 * snapshot and bills.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { formatMinor } from "@/lib/money";
import { generateBilling } from "@/lib/domain/billing";
import { assertBillingPublicationWindowOpen } from "@/lib/domain/billing-publication";
import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  a: z.number().int().min(2).max(9),
  b: z.number().int().min(2).max(9),
  answer: z.number().int().min(0).max(99),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  // Publication timing is a separate gate from data readiness. This check is
  // repeated by the server on every publish request; the UI cannot bypass it.
  await assertBillingPublicationWindowOpen(ctx.params.id);

  const result = await generateBilling(ctx.params.id, ctx.user.id, ctx.requestId, {
    a: body.a,
    b: body.b,
    answer: body.answer,
  });

  // Deliver the BILL_GENERATED notifications best-effort.
  sweepOutbox(100).catch(() => {});

  return {
    data: {
      ...result,
      mealChargeFormatted: formatMinor(result.mealChargeMinor),
      totalBilledFormatted: formatMinor(result.totalBilledMinor),
      totalDueFormatted: formatMinor(result.totalDueMinor),
      totalPaymentsAppliedFormatted: formatMinor(result.totalPaymentsAppliedMinor),
    },
  };
});
