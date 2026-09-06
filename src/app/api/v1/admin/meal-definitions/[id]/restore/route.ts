/** Restore an archived definition when no deletion lifecycle is active/completed. */
import { route } from "@/lib/auth/guard";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { restoreMealDefinition } from "@/lib/domain/meal-retirement";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const definition = await restoreMealDefinition({
    institutionId: ctx.institutionId,
    mealDefinitionId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
  });

  return {
    data: {
      id: definition.id,
      name: definition.name,
      active: definition.active,
      archivedAt: definition.archivedAt?.toISOString() ?? null,
    },
  };
});
