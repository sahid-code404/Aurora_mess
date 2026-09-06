/**
 * POST /api/v1/admin/guest-meals/[id]/cancel — admin cancel with mandatory
 * reason + audit. Allowed while the request is still active (REQUESTED /
 * CONFIRMED / LOCKED); CONSUMED rows cannot be cancelled. The host Resident
 * row is the mutation mutex so cancellation serializes with overrides, booking
 * and account lifecycle changes without requiring the host to remain ACTIVE.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  // Read only the immutable mutex key before the transaction. All lifecycle
  // state is re-read after the Resident lock is acquired.
  const target = await db.guestMealRequest.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId },
    select: { hostResidentId: true },
  });
  if (!target) throw new ApiError(CODES.NOT_FOUND, "This guest meal could not be found.", 404);

  const result = await db.$transaction(async (tx) => {
    await lockResidentLifecycleMutation(tx, ctx.institutionId, target.hostResidentId);

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
    const guard = await tx.guestMealRequest.updateMany({
      where: { id: guest.id, status: guest.status },
      data: { status: "CANCELLED", lockedAt: now },
    });
    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This guest meal was just changed. Refresh before trying again.",
        409
      );
    }

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

    return { ...guest, status: "CANCELLED", lockedAt: now };
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
