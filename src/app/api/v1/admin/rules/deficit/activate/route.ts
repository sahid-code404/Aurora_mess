/**
 * POST /api/v1/admin/rules/deficit/activate — activate a persisted rule version
 * for SHADOW evaluation only. Legacy funds policy remains authoritative.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { activateDeficitRuleVersion } from "@/lib/domain/rules/deficit-rules";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    versionId: z.string().min(1).max(120),
    expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    confirmImpact: z.literal(true),
    reason: reasonSchema,
  })
  .strict();

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const version = await activateDeficitRuleVersion({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    requestId: ctx.requestId,
    versionId: body.versionId,
    expectedChecksum: body.expectedChecksum,
    confirmImpact: body.confirmImpact,
    reason: body.reason,
  });

  return {
    data: {
      version,
      authority: "SHADOW_ONLY",
      message: "Activated for shadow evaluation. Legacy deficit policy still controls meal restriction.",
    },
  };
});
