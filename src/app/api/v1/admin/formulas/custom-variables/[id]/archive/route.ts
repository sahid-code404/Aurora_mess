/**
 * POST /api/v1/admin/formulas/custom-variables/[id]/archive — archive custom variable (auth ADMIN).
 */
import { route } from "@/lib/auth/guard";
import { archiveCustomVariable } from "@/lib/domain/formula/custom-variables";

export const dynamic = "force-dynamic";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const variableDefinitionId = ctx.params?.id as string;

  const result = await archiveCustomVariable({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    variableDefinitionId,
  });

  return { data: result };
});
