/**
 * POST /api/v1/admin/meals/[instanceId]/guest-override — admin override for guest meals.
 * Allows administrators to add, step (+/-), or remove guest meals for any active
 * resident even AFTER cutoff (admin authority). Records reason in audit trail
 * and notifies the resident.
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
    const instance = await tx.mealInstance.findFirst({
      where: { id: instanceId, institutionId: ctx.institutionId },
      include: { definition: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);

    const resident = await tx.user.findFirst({
      where: { id: body.residentId, institutionId: ctx.institutionId, role: "RESIDENT" },
      include: { profile: true },
    });
    if (!resident) throw new ApiError(CODES.NOT_FOUND, "This resident could not be found.", 404);
    if (resident.status !== "ACTIVE") {
      throw new ApiError(CODES.VALIDATION_FAILED, "Only active residents can be overridden.", 409);
    }

    const now = new Date();
    const isLocked = instance.status !== "OPEN" || now.getTime() >= instance.cutoffAt.getTime();
    if (!isLocked) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Admin guest override is only allowed after the meal cutoff has passed (${formatTimeLabel(instance.cutoffAt, inst.timezone)}). Before cutoff, residents manage their own guest meals.`,
        409
      );
    }

    // Active (non-cancelled) guest requests for this resident and instance
    const existing = await tx.guestMealRequest.findMany({
      where: {
        institutionId: ctx.institutionId,
        hostResidentId: resident.id,
        mealInstanceId: instance.id,
        status: { not: "CANCELLED" },
      },
      orderBy: { createdAt: "asc" },
    });

    const currentTotal = existing.reduce((s, g) => s + g.quantity, 0);

    // Determine the original user-requested baseline quantity.
    // If already admin-overridden, parse "Admin override|orig:X" from note.
    // Otherwise the current total IS the user's original baseline.
    let originalBaseline = currentTotal;
    for (const req of existing) {
      const match = req.note?.match(/Admin override\|orig:(\d+)/);
      if (match) {
        originalBaseline = parseInt(match[1], 10);
        break;
      }
    }

    const overrideNote = `Admin override|orig:${originalBaseline}`;

    const unitPriceMinor =
      instance.priceStrategySnapshot === "FIXED" && instance.fixedPriceMinorSnapshot != null
        ? instance.fixedPriceMinorSnapshot
        : inst.settings.guestMealPriceMinor;

    let targetRecordId: string | null = null;

    if (body.quantity === 0) {
      // Cancel all existing guest requests for this meal instance with override marker
      for (const req of existing) {
        await tx.guestMealRequest.update({
          where: { id: req.id },
          data: { status: "CANCELLED", lockedAt: now, note: overrideNote },
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
            lockedAt: now,
          },
        });
        targetRecordId = created.id;
      }
    } else if (existing.length > 0) {
      // Update primary request to the target quantity
      const primary = existing[0];
      targetRecordId = primary.id;
      await tx.guestMealRequest.update({
        where: { id: primary.id },
        data: {
          quantity: body.quantity,
          totalPriceMinor: body.quantity * primary.unitPriceMinor,
          lockedAt: isLocked ? now : primary.lockedAt,
          note: overrideNote,
        },
      });

      // Cancel any secondary duplicate active requests
      for (let i = 1; i < existing.length; i++) {
        await tx.guestMealRequest.update({
          where: { id: existing[i].id },
          data: { status: "CANCELLED", lockedAt: now, note: overrideNote },
        });
      }
    } else {
      // Create new request with target quantity
      const created = await tx.guestMealRequest.create({
        data: {
          institutionId: ctx.institutionId,
          hostResidentId: resident.id,
          mealInstanceId: instance.id,
          quantity: body.quantity,
          unitPriceMinor,
          totalPriceMinor: body.quantity * unitPriceMinor,
          status: "CONFIRMED",
          note: overrideNote,
          lockedAt: isLocked ? now : null,
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
    };
  });

  sweepOutboxSafe();

  return { data: result };
});
