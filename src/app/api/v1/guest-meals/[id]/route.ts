/**
 * RESIDENT GUEST MEAL QUANTITY — PATCH /api/v1/guest-meals/[id].
 * v1 change: the host resident adjusts their own guest count directly (the
 * ± stepper on the day's "Guest meals" row) — no admin permission, exactly
 * like toggling a normal meal: only while the meal instance's cutoff has NOT
 * passed. `expectedQuantity` is a light optimistic-concurrency guard (same
 * idea as expectedVersion on meal toggles); the price is recomputed from the
 * immutable unit snapshot. Audited + notified like every mutation.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatTimeLabel } from "@/lib/time";
import { formatMinor } from "@/lib/money";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { queueNotification, sweepOutboxSafe } from "@/lib/domain/notify";

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

  const guest = await db.guestMealRequest.findFirst({
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
  if (now.getTime() >= guest.mealInstance.cutoffAt.getTime()) {
    throw new ApiError(
      CODES.MEAL_CUTOFF_PASSED,
      `This meal locked at ${formatTimeLabel(guest.mealInstance.cutoffAt, tz)}. Guest meals can no longer be changed.`,
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
    // Nothing to change — idempotent no-op.
    return {
      data: {
        id: guest.id,
        mealInstanceId: guest.mealInstanceId,
        quantity: guest.quantity,
        unitPriceMinor: guest.unitPriceMinor,
        totalPriceMinor: guest.totalPriceMinor,
        status: guest.status,
      },
    };
  }

  const totalPriceMinor = guest.unitPriceMinor * body.quantity;
  const mealName = guest.mealInstance.definition?.name ?? "Meal";
  const serviceDate = keyOfUtcDate(guest.mealInstance.serviceDate);

  await db.$transaction(async (tx) => {
    await tx.guestMealRequest.update({
      where: { id: guest.id },
      data: { quantity: body.quantity, totalPriceMinor },
    });

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
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: guest.id,
      mealInstanceId: guest.mealInstanceId,
      quantity: body.quantity,
      unitPriceMinor: guest.unitPriceMinor,
      totalPriceMinor,
      status: guest.status,
    },
  };
});
