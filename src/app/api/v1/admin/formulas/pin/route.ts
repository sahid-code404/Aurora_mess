/**
 * POST /api/v1/admin/formulas/pin — toggle variable pinned status (auth ADMIN).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { togglePinVariable } from "@/lib/domain/formula/custom-variables";

export const dynamic = "force-dynamic";

const pinSchema = z.object({
  variableKey: z.string().min(1),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, pinSchema);

  const result = await togglePinVariable({
    institutionId: ctx.institutionId,
    variableKey: body.variableKey,
  });

  return { data: result };
});
