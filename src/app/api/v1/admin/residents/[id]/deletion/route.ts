/** GET /api/v1/admin/residents/[id]/deletion — latest USER deletion lifecycle. */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import {
  refreshDueResidentRetirements,
  serializeResidentDeletionRequest,
} from "@/lib/domain/resident-retirement";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await refreshDueResidentRetirements(ctx.institutionId);

  const resident = await db.user.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId, role: "RESIDENT" },
    select: { id: true, status: true },
  });
  if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);

  const request = await db.deletionRequest.findFirst({
    where: {
      institutionId: ctx.institutionId,
      entityType: "USER",
      entityId: resident.id,
    },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
  });

  return {
    data: {
      residentId: resident.id,
      residentStatus: resident.status,
      deletionRequest: serializeResidentDeletionRequest(request),
    },
  };
});
