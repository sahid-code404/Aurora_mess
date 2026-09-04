/**
 * POST /api/v1/admin/billing/periods/[id]/reopen — reopen a BILLED period
 * {reason} (auth ADMIN). v1 semantics (documented in worklog 3-c):
 *  - allowed only within 48 hours of billedAt;
 *  - status becomes REOPENED (an audit marker — the period is NOT re-opened
 *    for generation);
 *  - generated bills REMAIN authoritative; corrections happen through bill
 *    adjustments only (spec §59/§231).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { monthLabel, reopenBillingPeriod } from "@/lib/domain/billing";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const result = await reopenBillingPeriod(ctx.params.id, ctx.user.id, ctx.requestId, body.reason);
  return {
    data: {
      ...result,
      period: {
        ...result.period,
        monthLabel: monthLabel(result.period.year, result.period.month),
      },
    },
  };
});
