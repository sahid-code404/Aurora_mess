/**
 * POST /api/v1/admin/meals/[instanceId]/guest-override — admin override for guest meals.
 * Allows administrators to add, step (+/-), or remove guest meals for any active
 * resident after the authoritative meal lock boundary but before service ends.
 * Records a mandatory reason in the audit trail and notifies the resident.
 * Resident-row serialization prevents concurrent access-removal and guest
 * mutations from validating different account states.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { formatDateLabel, formatTimeLabel } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { queueNotification, sweepOutboxSafe } from "@/lib/domain/notify";
import { lockActiveResidentForMealMutation } from "@/lib/domain/resident-meal-mutation";

const bodySchema = z.object({
  residentId: z.string().min(1),
  quantity: z.coerce.number().int().min(0, "Quantity cannot be negative").max(20, "At most 20 guests per meal"),
  reason: reasonSchema,
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);
  const instanceId = ctx.params.instanceId;

  const result = await db.$transaction(async (tx) => {
    const resident = await lockActiveResidentForMealMutation(tx, ctx.institutionId, body.residentId);

    const instance = await tx.mealInstance.findFirst({
      where: { id: instanceId, institutionId: ctx.institutionId },
      include: { definition: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);

    const now = new Date();
    if (instance.status === "CANCELLED") {
      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);
    }
    if (now.getTime() < instance.lockAt.getTime()) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Admin guest override is only allowed after this meal locks (${formatTimeLabel(instance.lockAt, inst.timezone)}). Before then, residents manage their own guest meals.`,
        409
      );
    }
    if (now.getTime() >= instance.serviceEndAt.getTime()) {
      throw new ApiError(
        CODES.MEAL_NOT_AVAILABLE,
        "This meal service has already ended. Consumed guest-meal history cannot be rewritten; use the billing/refund correction flow for financial corrections.",
        409
      );
    }

    const existing = await tx.guestMealRequest.findMany({
      where: {
        institutionId: ctx.institutionId,
        hostResidentId: resident.id,
        mealInstanceId: instance.id,
        status: { not: "CANCELLED" },
      },
      orderBy: { createdAt: "asc" },
    });

    if (existing.some((request) => request.status === "CONSUMED")) {
      throw new ApiError(
        CODES.MEAL_NOT_AVAILABLE,
        "Consumed guest meals are historical records and cannot be changed.",
        409
      );
    }

    const currentTotal = existing.reduce((s, g) => s + g.quantity, 0);

    let originalBaseline = currentTotal;
    for (const req of existing) {
      const match = req.note?.match(/Admin override\|orig:(\d+)/);
      if (match) {
        originalBaseline = parseInt(match[1], 10);
        break;
      }
    }

    const overrideNote = `Admin override|orig:${originalBaseline}`;
    const lockBoundary = instance.lockAt;

    const unitPriceMinor =
      instance.priceStrategySnapshot === "FIXED" && instance.fixedPriceMinorSnapshot != null
        ? instance.fixedPriceMinorSnapshot
        : inst.settings.guestMealPriceMinor;

    let targetRecordId: string | null = null;

    if (body.quantity === 0) {
      for (const req of existing) {
        await tx.guestMealRequest.update({
          where: { id: req.id },
          data: {
            status: "CANCELLED",
            lockedAt: req.lockedAt ?? lockBoundary,
            note: overrideNote,
          },
        });
      }
      if (existing.length === 0) {
        const created = await tx.guestMealRequest.create({
          data: {
            institutionId: ctx.institutionId,
            hostResidentId: resident.id,
            mealInstanceId: instance.id,
            quantity: 0,
            unitPriceMinor,
            totalPriceMinor: 0,
            status: "CANCELLED",
            note: overrideNote,
            lockedAt: lockBoundary,
          },
        });
        targetRecordId = created.id;
      }
    } else if (existing.length > 0) {
      const primary = existing[0];
      targetRecordId = primary.id;
      await tx.guestMealRequest.update({
        where: { id: primary.id },
        data: {
          quantity: body.quantity,
          totalPriceMinor: body.quantity * primary.unitPriceMinor,
          status: "LOCKED",
          lockedAt: primary.lockedAt ?? lockBoundary,
          note: overrideNote,
        },
      });

      for (let i = 1; i < existing.length; i++) {
        await tx.guestMealRequest.update({
          where: { id: existing[i].id },
          data: {
            status: "CANCELLED",
            lockedAt: existing[i].lockedAt ?? lockBoundary,
            note: overrideNote,
          },
        });
      }
    } else {
      const created = await tx.guestMealRequest.create({
        data: {
          institutionId: ctx.institutionId,
          hostResidentId: resident.id,
          mealInstanceId: instance.id,
          quantity: body.quantity,
          unitPriceMinor,
          totalPriceMinor: body.quantity * unitPriceMinor,
          status: "LOCKED",
          note: overrideNote,
          lockedAt: lockBoundary,
        },
      });
      targetRecordId = created.id;
    }

    const mealName = instance.definition?.name ?? "Meal";
    const residentName = resident.profile?.fullName ?? resident.email;

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "GUEST_MEAL_OVERRIDE",
        entityType: "GUEST_MEAL_REQUEST",
        entityId: targetRecordId ?? instance.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ quantity: currentTotal }),
        afterSummary: JSON.stringify({ quantity: body.quantity }),
        metadata: {
          hostResidentId: resident.id,
          residentName,
          mealInstanceId: instance.id,
          mealName,
          previousQuantity: currentTotal,
          newQuantity: body.quantity,
          lockAt: instance.lockAt.toISOString(),
          cutoffAt: instance.cutoffAt.toISOString(),
        },
      },
      tx
    );

    await queueNotification(
      {
        institutionId: ctx.institutionId,
        userId: resident.id,
        type: "GUEST_MEAL_OVERRIDE",
        title: "Guest meal changed by admin",
        message:
          body.quantity === 0
            ? `Your guest meals for ${mealName} on ${formatDateLabel(instance.serviceDate)} were removed by the admin. Reason: ${body.reason}`
            : `Your guest meals for ${mealName} on ${formatDateLabel(instance.serviceDate)} were changed to ${body.quantity} by the admin. Reason: ${body.reason}`,
        entityRef: instance.id,
      },
      tx
    );

    return {
      mealInstanceId: instance.id,
      residentId: resident.id,
      quantity: body.quantity,
      previousQuantity: currentTotal,
      status: body.quantity === 0 ? "CANCELLED" : "LOCKED",
      lockAt: instance.lockAt.toISOString(),
      cutoffAt: instance.cutoffAt.toISOString(),
    };
  });

  await sweepOutboxSafe();

  return { data: result };
});
