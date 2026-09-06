/**
 * GET /api/v1/admin/rules/deficit — versioned deficit policy overview.
 * Read-only: if no persisted definition exists, the built-in shadow default is
 * returned without creating database rows.
 */
import { route } from "@/lib/auth/guard";
import { getDeficitRuleOverview } from "@/lib/domain/rules/deficit-rules";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const overview = await getDeficitRuleOverview(ctx.institutionId);
  return {
    data: {
      definition: overview.definition
        ? {
            id: overview.definition.id,
            key: overview.definition.key,
            name: overview.definition.name,
            description: overview.definition.description,
            policyType: overview.definition.policyType,
          }
        : null,
      versions: overview.versions,
      defaultRules: overview.defaultRules,
      authority: "SHADOW_ONLY",
    },
  };
});
