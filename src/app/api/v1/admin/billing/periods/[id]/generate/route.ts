/**
 * POST /api/v1/admin/billing/periods/[id]/generate — run billing (auth ADMIN).
 * Body: {a, b, answer} — the human confirmation echo of the readiness
 * challenge (answer must equal a + b). The domain transaction re-runs
 * readiness inside the OPEN→CLOSING guard; failures roll back cleanly.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { formatMinor } from "@/lib/money";
import { generateBilling } from "@/lib/domain/billing";
import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  a: z.number().int().min(2).max(9),
  b: z.number().int().min(2).max(9),
  answer: z.number().int().min(0).max(99),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
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
