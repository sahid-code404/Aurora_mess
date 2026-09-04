/**
 * POST /api/v1/admin/formulas/custom-variables/[id]/values — set monthly/period value (auth ADMIN).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { setCustomVariableValue } from "@/lib/domain/formula/custom-variables";

export const dynamic = "force-dynamic";

const valueSchema = z.object({
  billingPeriodKey: z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM"),
  value: z.number(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const variableDefinitionId = ctx.params?.id as string;
  const body = await parseBody(ctx.req, valueSchema);

  const result = await setCustomVariableValue({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    variableDefinitionId,
    billingPeriodKey: body.billingPeriodKey,
    value: body.value,
  });

  return { data: result };
});
