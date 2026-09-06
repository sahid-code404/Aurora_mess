/**
 * RESIDENT GUEST MEAL CANCEL (self-service) — POST /api/v1/guest-meals/[id]/cancel.
 * v1 change: guest meals no longer need admin permission to turn off — the
 * host resident can cancel their own request directly, exactly like turning a
 * normal meal OFF: allowed only while the meal instance's cutoff has NOT
 * passed ("under cutoff"). CONSUMED rows cannot be cancelled; CANCELLED rows
 * are rejected as already cancelled. Audited + notified like every mutation.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatTimeLabel } from "@/lib/time";
import { formatMinor } from "@/lib/money";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { notifyAdmins, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;

  const guest = await db.guestMealRequest.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId, hostResidentId: ctx.user.id },
    include: { mealInstance: { include: { definition: { select: { name: true } } } } },
  });
  if (!guest) throw new ApiError(CODES.NOT_FOUND, "This guest meal could not be found.", 404);
  if (guest.status === "CANCELLED") {
    throw new ApiError(CODES.VALIDATION_FAILED, "This guest meal is already cancelled.", 409);
  }
  if (guest.status === "CONSUMED") {
    throw new ApiError(CODES.VALIDATION_FAILED, "Consumed guest meals cannot be cancelled.", 409);
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

  const mealName = guest.mealInstance.definition?.name ?? "Meal";
  const serviceDate = keyOfUtcDate(guest.mealInstance.serviceDate);

  await db.$transaction(async (tx) => {
    await tx.guestMealRequest.update({
      where: { id: guest.id },
      data: { status: "CANCELLED", lockedAt: now },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "GUEST_MEAL_CANCELLED",
        entityType: "GUEST_MEAL_REQUEST",
        entityId: guest.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({
          status: guest.status,
          quantity: guest.quantity,
          totalPriceMinor: guest.totalPriceMinor,
        }),
        afterSummary: JSON.stringify({ status: "CANCELLED" }),
        metadata: { mealName, serviceDate, selfService: true },
      },
      tx
    );

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "GUEST_MEAL_CANCELLED",
        title: "Guest meals cancelled",
        message: `${residentName} cancelled ${guest.quantity} guest meal(s) for ${mealName} on ${serviceDate}.`,
        entityRef: guest.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: guest.id,
      types: ["GUEST_MEAL_BOOKED"],
      actorUserId: ctx.user.id,
      actorRole: "RESIDENT",
      reason: "Guest meal cancelled by resident",
      client: tx,
    });
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: guest.id,
      status: "CANCELLED" as const,
      mealInstanceId: guest.mealInstanceId,
      quantity: guest.quantity,
      totalPriceMinor: guest.totalPriceMinor,
    },
  };
});
