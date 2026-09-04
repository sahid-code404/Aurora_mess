/**
 * POST /api/v1/admin/guest-meals/[id]/cancel — admin cancel with mandatory
 * reason + audit. Allowed while the request is still active (REQUESTED /
 * CONFIRMED / LOCKED); CONSUMED rows cannot be cancelled.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    const guest = await tx.guestMealRequest.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!guest) throw new ApiError(CODES.NOT_FOUND, "This guest meal could not be found.", 404);
    if (guest.status === "CANCELLED") {
      throw new ApiError(CODES.VALIDATION_FAILED, "This guest meal is already cancelled.", 409);
    }
    if (guest.status === "CONSUMED") {
      throw new ApiError(CODES.VALIDATION_FAILED, "Consumed guest meals cannot be cancelled.", 409);
    }

    const now = new Date();
    const updated = await tx.guestMealRequest.update({
      where: { id: guest.id },
      data: { status: "CANCELLED", lockedAt: now },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "GUEST_MEAL_CANCELLED",
        entityType: "GUEST_MEAL_REQUEST",
        entityId: guest.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: guest.status, quantity: guest.quantity, totalPriceMinor: guest.totalPriceMinor }),
        afterSummary: JSON.stringify({ status: "CANCELLED" }),
        metadata: { hostResidentId: guest.hostResidentId, mealInstanceId: guest.mealInstanceId },
      },
      tx
    );

    return updated;
  });

  return {
    data: {
      id: result.id,
      status: result.status,
      quantity: result.quantity,
      totalPriceMinor: result.totalPriceMinor,
    },
  };
});
