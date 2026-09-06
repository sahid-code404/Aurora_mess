/** Cancel a pending/blocked meal-definition deletion without erasing history. */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { cancelMealDefinitionDeletion } from "@/lib/domain/meal-retirement";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);
  const result = await cancelMealDefinitionDeletion({
    institutionId: ctx.institutionId,
    mealDefinitionId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
  });

  return {
    data: {
      deletionRequestId: result.request.id,
      definitionId: result.definition.id,
      status: result.request.status,
      cancelReason: result.request.cancelReason,
      cancelledAt: result.request.cancelledAt?.toISOString() ?? null,
      active: result.definition.active,
      archivedAt: result.definition.archivedAt?.toISOString() ?? null,
      deleteRequestedAt: result.definition.deleteRequestedAt?.toISOString() ?? null,
    },
  };
});
