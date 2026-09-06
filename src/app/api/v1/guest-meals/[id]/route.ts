/**
 * RESIDENT GUEST MEAL QUANTITY — PATCH /api/v1/guest-meals/[id].
 * The host may adjust their own guest count only before the meal lock instant.
 * The Resident User row is the shared mutex with access removal, booking,
 * cancellation and Admin guest override. Every lifecycle/cutoff/concurrency
 * fact is therefore re-read inside the same transaction before the write.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatTimeLabel } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { sweepOutboxSafe } from "@/lib/domain/notify";
import { lockActiveResidentForMealMutation } from "@/lib/domain/resident-meal-mutation";

const bodySchema = z.object({
  quantity: z.coerce
    .number()
    .int()
    .min(1, "At least 1 guest is required.")
    .max(10, "At most 10 guests per request."),
  expectedQuantity: z.coerce.number().int().min(1).max(10).optional(),
});

export const PATCH = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    await lockActiveResidentForMealMutation(tx, ctx.institutionId, ctx.user.id);

    const guest = await tx.guestMealRequest.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId, hostResidentId: ctx.user.id },
      include: { mealInstance: { include: { definition: { select: { name: true } } } } },
    });
    if (!guest) throw new ApiError(CODES.NOT_FOUND, "This guest meal could not be found.", 404);
    if (guest.status === "CANCELLED") {
      throw new ApiError(CODES.VALIDATION_FAILED, "This guest meal is already cancelled.", 409);
    }
    if (guest.status === "CONSUMED") {
      throw new ApiError(CODES.VALIDATION_FAILED, "Consumed guest meals cannot be changed.", 409);
    }

    const now = new Date();
    if (guest.mealInstance.status === "CANCELLED") {
      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);
    }
    if (now.getTime() >= guest.mealInstance.lockAt.getTime()) {
      throw new ApiError(
        CODES.MEAL_CUTOFF_PASSED,
        `This meal locked at ${formatTimeLabel(guest.mealInstance.lockAt, tz)}. Guest meals can no longer be changed.`,
        409
      );
    }

    if (body.expectedQuantity !== undefined && body.expectedQuantity !== guest.quantity) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This guest meal was just changed. Please refresh and try again.",
        409
      );
    }

    if (body.quantity === guest.quantity) {
      return {
        id: guest.id,
        mealInstanceId: guest.mealInstanceId,
        quantity: guest.quantity,
        unitPriceMinor: guest.unitPriceMinor,
        totalPriceMinor: guest.totalPriceMinor,
        status: guest.status,
      };
    }

    const totalPriceMinor = guest.unitPriceMinor * body.quantity;
    const guard = await tx.guestMealRequest.updateMany({
      where: {
        id: guest.id,
        institutionId: ctx.institutionId,
        hostResidentId: ctx.user.id,
        status: guest.status,
        quantity: guest.quantity,
      },
      data: { quantity: body.quantity, totalPriceMinor },
    });
    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This guest meal was just changed. Please refresh and try again.",
        409
      );
    }

    const mealName = guest.mealInstance.definition?.name ?? "Meal";
    const serviceDate = keyOfUtcDate(guest.mealInstance.serviceDate);

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "GUEST_MEAL_ADJUSTED",
        entityType: "GUEST_MEAL_REQUEST",
        entityId: guest.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ quantity: guest.quantity, totalPriceMinor: guest.totalPriceMinor }),
        afterSummary: JSON.stringify({ quantity: body.quantity, totalPriceMinor }),
        metadata: { mealName, serviceDate, selfService: true },
      },
      tx
    );

    return {
      id: guest.id,
      mealInstanceId: guest.mealInstanceId,
      quantity: body.quantity,
      unitPriceMinor: guest.unitPriceMinor,
      totalPriceMinor,
      status: guest.status,
    };
  });

  await sweepOutboxSafe();
  return { data: result };
});
