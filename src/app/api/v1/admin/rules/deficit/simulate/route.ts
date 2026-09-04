/**
 * POST /api/v1/admin/rules/deficit/simulate — preview a saved or unsaved
 * candidate against explicit financial facts and compare with the active shadow
 * policy. No rule status or resident state is mutated.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { simulateDeficitRuleSet } from "@/lib/domain/rules/deficit-rules";

export const dynamic = "force-dynamic";

const contextSchema = z
  .object({
    availableMinor: z.number().int().safe(),
    deficitThresholdMinor: z.number().int().min(0).safe(),
    gracePeriodDays: z.number().int().min(0).max(365),
    deficitPolicyEnabled: z.boolean(),
    oldestUnsettledDueAt: z.string().datetime().nullable().optional(),
    hasActiveExemption: z.boolean(),
    activeExemptionExpiresAt: z.string().datetime().nullable().optional(),
    now: z.string().datetime().optional(),
  })
  .strict();

const bodySchema = z
  .object({
    versionId: z.string().min(1).max(120).optional(),
    rules: z.unknown().optional(),
    context: contextSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasVersion = Boolean(value.versionId);
    const hasRules = value.rules !== undefined;
    if (hasVersion === hasRules) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of versionId or rules.",
        path: ["versionId"],
      });
    }
  });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const simulation = await simulateDeficitRuleSet({
    institutionId: ctx.institutionId,
    versionId: body.versionId,
    rules: body.rules,
    context: {
      availableMinor: body.context.availableMinor,
      deficitThresholdMinor: body.context.deficitThresholdMinor,
      gracePeriodDays: body.context.gracePeriodDays,
      deficitPolicyEnabled: body.context.deficitPolicyEnabled,
      oldestUnsettledDueAt: body.context.oldestUnsettledDueAt
        ? new Date(body.context.oldestUnsettledDueAt)
        : null,
      hasActiveExemption: body.context.hasActiveExemption,
      activeExemptionExpiresAt: body.context.activeExemptionExpiresAt
        ? new Date(body.context.activeExemptionExpiresAt)
        : null,
      now: body.context.now ? new Date(body.context.now) : new Date(),
    },
  });

  return { data: { ...simulation, authority: "SHADOW_ONLY" } };
});
