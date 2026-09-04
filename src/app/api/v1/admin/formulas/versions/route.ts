/**
 * POST /api/v1/admin/formulas/versions — create a new immutable formula version (auth ADMIN).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { createFormulaVersion } from "@/lib/domain/formula/versions";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mode: z.enum(["FORMULA", "NATURAL_LANGUAGE"]),
  source: z.string().min(1, "Describe the formula or enter formula text.").max(2500),
  outputVariableKey: z.string().optional(),
  name: z.string().max(100).optional(),
  reason: reasonSchema.optional(),
  effective: z.enum(["NEXT_PERIOD", "CURRENT_OPEN"]).default("NEXT_PERIOD"),
  confirmImpact: z.boolean().optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const outcome = await createFormulaVersion({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    requestId: ctx.requestId,
    outputVariableKey: body.outputVariableKey,
    name: body.name,
    mode: body.mode,
    source: body.source,
    reason: body.reason,
    effective: body.effective,
    confirmImpact: body.confirmImpact,
  });
  return { data: outcome };
});
