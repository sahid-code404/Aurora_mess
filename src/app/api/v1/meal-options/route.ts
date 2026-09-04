/**
 * GET /api/v1/meal-options — small resident-safe list of selectable meal
 * definitions. Used by leave scope selection; never exposes admin-only config.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const definitions = await db.mealDefinition.findMany({
    where: {
      institutionId: ctx.institutionId,
      active: true,
      archivedAt: null,
      defaultVisible: true,
      mealType: { not: "GUEST_ONLY" },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      icon: true,
      colorToken: true,
      mealType: true,
    },
  });

  return { data: definitions };
});
