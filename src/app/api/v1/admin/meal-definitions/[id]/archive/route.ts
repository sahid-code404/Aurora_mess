/**
 * POST /api/v1/admin/meal-definitions/[id]/archive — tombstone the definition:
 * archivedAt=now (+active=false). Future instances stop being generated;
 * historical instances/versions/resident meals stay intact (spec §69 precursor).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const result = await db.$transaction(async (tx) => {
    const def = await tx.mealDefinition.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
    if (def.archivedAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This meal definition is already archived.", 409);
    }
    const now = new Date();
    const updated = await tx.mealDefinition.update({
      where: { id: def.id },
      data: { archivedAt: now, active: false },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "MEAL_DEFINITION_ARCHIVED",
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ name: def.name, archivedAt: null }),
        afterSummary: JSON.stringify({ name: def.name, archivedAt: now.toISOString() }),
        metadata: { note: "Future instances stop; history preserved." },
      },
      tx
    );
    return updated;
  });

  return {
    data: {
      id: result.id,
      name: result.name,
      archivedAt: result.archivedAt ? result.archivedAt.toISOString() : null,
      active: result.active,
    },
  };
});
