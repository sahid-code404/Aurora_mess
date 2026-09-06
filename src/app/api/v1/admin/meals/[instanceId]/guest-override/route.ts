/**
 * POST /api/v1/admin/meals/[instanceId]/guest-override — admin guest quantity correction.
 *
 * - Before lockAt: residents own the guest-meal choice; Admin cannot override.
 * - After lockAt but before service end: Admin may override the locked quantity.
 * - After service end: Admin may correct consumed guest history while the
 *   billing period is still mutable. The row remains CONSUMED (or CANCELLED
 *   when corrected to zero), the change is reasoned/audited, and all existing
 *   formula/billing/count providers see the corrected frozen quantity.
 * - Once billing generation starts, or the month is BILLED/REOPENED, the guest
 *   source record is frozen and corrections must use bill-adjustment flows.
 *
 * Lock order: Institution financial mutex → BillingPeriod row → Resident row.
 * This prevents a guest-history correction from racing a billing snapshot.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { formatDateLabel, formatTimeLabel } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { queueNotification, sweepOutboxSafe } from "@/lib/domain/notify";
import { lockActiveResidentForMealMutation } from "@/lib/domain/resident-meal-mutation";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";

const bodySchema = z.object({
  residentId: z.string().min(1),
  quantity: z.coerce.number().int().min(0, "Quantity cannot be negative").max(20, "At most 20 guests per meal"),
  reason: reasonSchema,
});

type LockedPeriod = { status: string; generationState: string | null };

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);
  const instanceId = ctx.params.instanceId;

  const result = await db.$transaction(async (tx) => {
    // Guest quantity is a billing/formula input. Serialize with every other
    // institution-wide financial input before making any lifecycle decision.
    await lockInstitutionFinancialMutation(tx, ctx.institutionId);

    const instance = await tx.mealInstance.findFirst({
      where: { id: instanceId, institutionId: ctx.institutionId },
      include: { definition: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);

    const serviceDateKey = keyOfUtcDate(instance.serviceDate);
    const [year, month] = serviceDateKey.split("-").map(Number);

    // Lock the exact BillingPeriod row as well. Billing generation claims this
    // same row by changing generationState to CLOSING, so whichever transaction
    // wins the row lock establishes the authoritative ordering.
    const periodRows = await tx.$queryRaw<LockedPeriod[]>(Prisma.sql`
      SELECT "status", "generationState"
      FROM "BillingPeriod"
      WHERE "institutionId" = ${ctx.institutionId}
        AND "year" = ${year}
        AND "month" = ${month}
      FOR UPDATE
    `);
    const period = periodRows[0] ?? null;
    if (
      period &&
      (period.status === "BILLED" ||
        period.status === "REOPENED" ||
        period.generationState === "CLOSING")
    ) {
      throw new ApiError(
        CODES.BILLING_PERIOD_CLOSED,
        `Guest meals for ${year}-${String(month).padStart(2, "0")} are frozen because billing has already started or completed. Use a bill adjustment for financial corrections.`,
        409,
        { quantity: "This guest-meal source record belongs to a frozen billing period." }
      );
    }

    // Resident lifecycle mutations share the same physical User-row mutex.
    // Acquire it only after the institution/period financial locks.
    const resident = await lockActiveResidentForMealMutation(tx, ctx.institutionId, body.residentId);

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

    const serviceEnded = now.getTime() >= instance.serviceEndAt.getTime();
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
    if (currentTotal === body.quantity) {
      return {
        mealInstanceId: instance.id,
        residentId: resident.id,
        quantity: body.quantity,
        previousQuantity: currentTotal,
        status: existing[0]?.status ?? (serviceEnded ? "CONSUMED" : "LOCKED"),
        mode: serviceEnded ? "POST_SERVICE_CORRECTION" : "LOCKED_OVERRIDE",
        changed: false,
        lockAt: instance.lockAt.toISOString(),
        cutoffAt: instance.cutoffAt.toISOString(),
      };
    }

    let originalBaseline = currentTotal;
    for (const req of existing) {
      const match = req.note?.match(/(?:Admin override|Admin post-service correction)\|orig:(\d+)/);
      if (match) {
        originalBaseline = parseInt(match[1], 10);
        break;
      }
    }

    const notePrefix = serviceEnded ? "Admin post-service correction" : "Admin override";
    const overrideNote = `${notePrefix}|orig:${originalBaseline}`;
    const lockBoundary = instance.lockAt;
    const nextActiveStatus = serviceEnded ? "CONSUMED" : "LOCKED";

    // Existing booking price is the strongest historical source. For a late
    // correction that creates the first guest row, fall back to the instance's
    // fixed snapshot (when configured), then the current institution guest rate.
    const unitPriceMinor =
      existing[0]?.unitPriceMinor ??
      (instance.priceStrategySnapshot === "FIXED" && instance.fixedPriceMinorSnapshot != null
        ? instance.fixedPriceMinorSnapshot
        : inst.settings.guestMealPriceMinor);

    let targetRecordId: string | null = existing[0]?.id ?? null;

    if (body.quantity === 0) {
      // Preserve the original quantities/prices on the rows and remove them from
      // effective guest totals by cancelling them. The audit below records why
      // this historical correction happened.
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
    } else if (existing.length > 0) {
      const primary = existing[0];
      targetRecordId = primary.id;
      await tx.guestMealRequest.update({
        where: { id: primary.id },
        data: {
          quantity: body.quantity,
          totalPriceMinor: body.quantity * primary.unitPriceMinor,
          status: nextActiveStatus,
          lockedAt: primary.lockedAt ?? lockBoundary,
          note: overrideNote,
        },
      });

      // Consolidate any duplicate active rows into the primary row while keeping
      // the old row contents available as cancelled historical records.
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
          status: nextActiveStatus,
          note: overrideNote,
          lockedAt: lockBoundary,
        },
      });
      targetRecordId = created.id;
    }

    const mealName = instance.definition?.name ?? "Meal";
    const residentName = resident.profile?.fullName ?? resident.email;
    const action = serviceEnded ? "GUEST_MEAL_POST_SERVICE_CORRECTED" : "GUEST_MEAL_OVERRIDE";
    const mode = serviceEnded ? "POST_SERVICE_CORRECTION" : "LOCKED_OVERRIDE";

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action,
        entityType: "GUEST_MEAL_REQUEST",
        entityId: targetRecordId ?? instance.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({
          quantity: currentTotal,
          rows: existing.map((g) => ({ id: g.id, quantity: g.quantity, status: g.status, totalPriceMinor: g.totalPriceMinor })),
        }),
        afterSummary: JSON.stringify({
          quantity: body.quantity,
          status: body.quantity === 0 ? "CANCELLED" : nextActiveStatus,
          unitPriceMinor,
          totalPriceMinor: body.quantity * unitPriceMinor,
          mode,
        }),
        metadata: {
          hostResidentId: resident.id,
          residentName,
          mealInstanceId: instance.id,
          mealName,
          previousQuantity: currentTotal,
          newQuantity: body.quantity,
          quantityDelta: body.quantity - currentTotal,
          postService: serviceEnded,
          serviceEndedAt: instance.serviceEndAt.toISOString(),
          lockAt: instance.lockAt.toISOString(),
          cutoffAt: instance.cutoffAt.toISOString(),
          billingPeriod: `${year}-${String(month).padStart(2, "0")}`,
        },
      },
      tx
    );

    await queueNotification(
      {
        institutionId: ctx.institutionId,
        userId: resident.id,
        type: "GUEST_MEAL_OVERRIDE",
        title: serviceEnded ? "Guest meal history corrected" : "Guest meal changed by admin",
        message:
          body.quantity === 0
            ? `Your guest meals for ${mealName} on ${formatDateLabel(instance.serviceDate)} were ${serviceEnded ? "corrected to zero" : "removed"} by the admin. Reason: ${body.reason}`
            : `Your guest meals for ${mealName} on ${formatDateLabel(instance.serviceDate)} were ${serviceEnded ? "corrected" : "changed"} to ${body.quantity} by the admin. Reason: ${body.reason}`,
        entityRef: instance.id,
      },
      tx
    );

    return {
      mealInstanceId: instance.id,
      residentId: resident.id,
      quantity: body.quantity,
      previousQuantity: currentTotal,
      status: body.quantity === 0 ? "CANCELLED" : nextActiveStatus,
      mode,
      changed: true,
      lockAt: instance.lockAt.toISOString(),
      cutoffAt: instance.cutoffAt.toISOString(),
    };
  });

  await sweepOutboxSafe();

  return { data: result };
});
