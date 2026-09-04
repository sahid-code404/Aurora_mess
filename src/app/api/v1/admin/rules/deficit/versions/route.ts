/**
 * POST /api/v1/admin/rules/deficit/versions — create an immutable rule draft.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { createDeficitRuleDraft } from "@/lib/domain/rules/deficit-rules";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    rules: z.unknown(),
    reason: reasonSchema,
  })
  .strict();

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const version = await createDeficitRuleDraft({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    requestId: ctx.requestId,
    rules: body.rules,
    reason: body.reason,
  });

  return { data: { version, authority: "SHADOW_ONLY" } };
});
