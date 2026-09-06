/**
 * POST /api/v1/admin/meals/[instanceId]/guest-override — Admin guest correction.
 *
 * Before lock: Residents manage their own guest meals.
 * After lock and before service end: Admin may override the locked guest count.
 * After service end but before monthly billing is finalized: Admin may correct
 * the consumed quantity. CONSUMED remains terminal; the before/after facts and
 * mandatory reason are preserved in the audit trail.
 * After billing starts/finalizes: guest counts are frozen and corrections move
 * to the bill/refund correction lifecycle instead of rewriting billing inputs.
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
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import {
  applyAdminGuestMealQuantityCorrection,
  assertGuestMealCorrectionPeriodMutable,
} from "@/lib/domain/guest-meal-admin-correction";

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
    // Global lock order: Institution financial mutex -> Resident mutex.
    // Billing takes the same Institution mutex, so a correction and billing
    // generation can never snapshot different guest totals concurrently.
    await lockInstitutionFinancialMutation(tx, ctx.institutionId);
    const resident = await lockActiveResidentForMealMutation(tx, ctx.institutionId, body.residentId);

    const instance = await tx.mealInstance.findFirst({
      where: { id: instanceId, institutionId: ctx.institutionId },
      include: { definition: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);
    if (instance.status === "CANCELLED") {
      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);
    }

    const now = new Date();
    if (now.getTime() < instance.lockAt.getTime()) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Admin guest correction is available after this meal locks (${formatTimeLabel(instance.lockAt, inst.timezone)}). Before then, residents manage their own guest meals.`,
        409
      );
    }

    // Re-read this month under the Institution mutex. BILLED/REOPENED periods
    // and in-progress generation are immutable financial boundaries.
    await assertGuestMealCorrectionPeriodMutable(tx, ctx.institutionId, instance.serviceDate);

    const serviceEnded = now.getTime() >= instance.serviceEndAt.getTime();
    const unitPriceMinor =
      instance.priceStrategySnapshot === "FIXED" && instance.fixedPriceMinorSnapshot != null
        ? instance.fixedPriceMinorSnapshot
        : inst.settings.guestMealPriceMinor;

    const mutation = await applyAdminGuestMealQuantityCorrection({
      client: tx,
      institutionId: ctx.institutionId,
      residentId: resident.id,
      mealInstanceId: instance.id,
      targetQuantity: body.quantity,
      unitPriceMinor,
      lockAt: instance.lockAt,
      serviceEnded,
    });

    const mealName = instance.definition?.name ?? "Meal";
    const residentName = resident.profile?.fullName ?? resident.email;
    const correctionMode = serviceEnded ? "POST_SERVICE_CORRECTION" : "LOCKED_OVERRIDE";

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: serviceEnded ? "GUEST_MEAL_POST_SERVICE_CORRECTION" : "GUEST_MEAL_OVERRIDE",
        entityType: "GUEST_MEAL_REQUEST",
        entityId: mutation.targetRecordId ?? instance.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({
          quantity: mutation.currentTotal,
          records: mutation.beforeRecords,
        }),
        afterSummary: JSON.stringify({
          quantity: body.quantity,
          lifecycleStatus: mutation.status,
          correctionMode,
        }),
        metadata: {
          hostResidentId: resident.id,
          residentName,
          mealInstanceId: instance.id,
          mealName,
          previousQuantity: mutation.currentTotal,
          newQuantity: body.quantity,
          originalBaseline: mutation.originalBaseline,
          correctionMode,
          serviceEnded,
          lockAt: instance.lockAt.toISOString(),
          serviceEndAt: instance.serviceEndAt.toISOString(),
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
        title: serviceEnded ? "Guest meal corrected by admin" : "Guest meal changed by admin",
        message:
          body.quantity === 0
            ? `Your guest meals for ${mealName} on ${formatDateLabel(instance.serviceDate)} were corrected to 0 by the admin. Reason: ${body.reason}`
            : `Your guest meals for ${mealName} on ${formatDateLabel(instance.serviceDate)} were ${serviceEnded ? "corrected" : "changed"} to ${body.quantity} by the admin. Reason: ${body.reason}`,
        entityRef: instance.id,
      },
      tx
    );

    return {
      mealInstanceId: instance.id,
      residentId: resident.id,
      quantity: body.quantity,
      previousQuantity: mutation.currentTotal,
      status: mutation.status,
      correctionMode,
      serviceEnded,
      lockAt: instance.lockAt.toISOString(),
      cutoffAt: instance.cutoffAt.toISOString(),
    };
  });

  await sweepOutboxSafe();
  return { data: result };
});
