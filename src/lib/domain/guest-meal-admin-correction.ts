import { ApiError, CODES } from "@/lib/errors";

export type GuestCorrectionPeriodState = {
  status: string;
  generationState: string | null;
} | null;

export function guestMealCorrectionBlockReason(period: GuestCorrectionPeriodState): string | null {
  if (!period) return null;
  if (period.generationState === "CLOSING") {
    return "Billing generation is currently in progress for this month. Guest meals cannot be changed until that process finishes.";
  }
  if (period.status === "BILLED" || period.status === "REOPENED" || period.generationState === "COMPLETED") {
    return "Billing for this month has already been finalized. Guest meal counts are frozen; use the bill/refund correction flow for post-bill financial corrections.";
  }
  return null;
}

/**
 * Call only after the Institution financial mutex has been acquired. This makes
 * the check authoritative against a concurrent billing run.
 */
export async function assertGuestMealCorrectionPeriodMutable(
  client: any,
  institutionId: string,
  serviceDate: Date
): Promise<void> {
  const year = serviceDate.getUTCFullYear();
  const month = serviceDate.getUTCMonth() + 1;
  const period = await client.billingPeriod.findUnique({
    where: { institutionId_year_month: { institutionId, year, month } },
    select: { status: true, generationState: true },
  });
  const reason = guestMealCorrectionBlockReason(period);
  if (reason) throw new ApiError(CODES.VALIDATION_FAILED, reason, 409);
}

export type AdminGuestCorrectionResult = {
  currentTotal: number;
  targetRecordId: string | null;
  status: "LOCKED" | "CANCELLED" | "CONSUMED";
  originalBaseline: number;
  beforeRecords: Array<{
    id: string;
    quantity: number;
    unitPriceMinor: number;
    totalPriceMinor: number;
    status: string;
  }>;
};

/**
 * Apply an Admin guest-count override after the meal lock boundary.
 *
 * Before service end, normal lock-time override semantics are preserved.
 * After service end, CONSUMED remains terminal: rows are never moved backwards
 * or cancelled. Their quantity/amount is corrected in place under an audited
 * Admin action, and surplus rows are retained as zero-quantity CONSUMED history.
 * This is allowed only while the billing period is still mutable.
 */
export async function applyAdminGuestMealQuantityCorrection(options: {
  client: any;
  institutionId: string;
  residentId: string;
  mealInstanceId: string;
  targetQuantity: number;
  unitPriceMinor: number;
  lockAt: Date;
  serviceEnded: boolean;
}): Promise<AdminGuestCorrectionResult> {
  const {
    client,
    institutionId,
    residentId,
    mealInstanceId,
    targetQuantity,
    unitPriceMinor,
    lockAt,
    serviceEnded,
  } = options;

  const existing = await client.guestMealRequest.findMany({
    where: {
      institutionId,
      hostResidentId: residentId,
      mealInstanceId,
      status: { not: "CANCELLED" },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!serviceEnded && existing.some((request: { status: string }) => request.status === "CONSUMED")) {
    throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "Consumed guest meals cannot be moved back into an active meal lifecycle.", 409);
  }

  const currentTotal = existing.reduce((sum: number, row: { quantity: number }) => sum + row.quantity, 0);
  const beforeRecords = existing.map((row: any) => ({
    id: row.id,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    totalPriceMinor: row.totalPriceMinor,
    status: row.status,
  }));

  let originalBaseline = currentTotal;
  for (const request of existing) {
    const match = request.note?.match(/Admin override\|orig:(\d+)/);
    if (match) {
      originalBaseline = Number.parseInt(match[1], 10);
      break;
    }
  }

  const note = `Admin override|orig:${originalBaseline}${serviceEnded ? "|post-service" : ""}`;
  let targetRecordId: string | null = existing[0]?.id ?? null;

  if (serviceEnded) {
    // Service history stays terminal. A correction changes only the financial /
    // quantity facts while preserving CONSUMED as the lifecycle state.
    if (existing.length === 0) {
      const created = await client.guestMealRequest.create({
        data: {
          institutionId,
          hostResidentId: residentId,
          mealInstanceId,
          quantity: targetQuantity,
          unitPriceMinor,
          totalPriceMinor: targetQuantity * unitPriceMinor,
          status: "CONSUMED",
          note,
          lockedAt: lockAt,
        },
      });
      targetRecordId = created.id;
    } else {
      const primary = existing[0];
      await client.guestMealRequest.update({
        where: { id: primary.id },
        data: {
          quantity: targetQuantity,
          totalPriceMinor: targetQuantity * primary.unitPriceMinor,
          status: "CONSUMED",
          lockedAt: primary.lockedAt ?? lockAt,
          note,
        },
      });
      // Keep every already-consumed row terminal. Zeroing superseded rows avoids
      // double counting while retaining their historical identity/provenance.
      for (let index = 1; index < existing.length; index += 1) {
        const row = existing[index];
        await client.guestMealRequest.update({
          where: { id: row.id },
          data: {
            quantity: 0,
            totalPriceMinor: 0,
            status: "CONSUMED",
            lockedAt: row.lockedAt ?? lockAt,
            note,
          },
        });
      }
    }
    return {
      currentTotal,
      targetRecordId,
      status: "CONSUMED",
      originalBaseline,
      beforeRecords,
    };
  }

  if (targetQuantity === 0) {
    for (const request of existing) {
      await client.guestMealRequest.update({
        where: { id: request.id },
        data: { status: "CANCELLED", lockedAt: request.lockedAt ?? lockAt, note },
      });
    }
    if (existing.length === 0) {
      const created = await client.guestMealRequest.create({
        data: {
          institutionId,
          hostResidentId: residentId,
          mealInstanceId,
          quantity: 0,
          unitPriceMinor,
          totalPriceMinor: 0,
          status: "CANCELLED",
          note,
          lockedAt: lockAt,
        },
      });
      targetRecordId = created.id;
    }
    return { currentTotal, targetRecordId, status: "CANCELLED", originalBaseline, beforeRecords };
  }

  if (existing.length > 0) {
    const primary = existing[0];
    targetRecordId = primary.id;
    await client.guestMealRequest.update({
      where: { id: primary.id },
      data: {
        quantity: targetQuantity,
        totalPriceMinor: targetQuantity * primary.unitPriceMinor,
        status: "LOCKED",
        lockedAt: primary.lockedAt ?? lockAt,
        note,
      },
    });
    for (let index = 1; index < existing.length; index += 1) {
      const row = existing[index];
      await client.guestMealRequest.update({
        where: { id: row.id },
        data: { status: "CANCELLED", lockedAt: row.lockedAt ?? lockAt, note },
      });
    }
  } else {
    const created = await client.guestMealRequest.create({
      data: {
        institutionId,
        hostResidentId: residentId,
        mealInstanceId,
        quantity: targetQuantity,
        unitPriceMinor,
        totalPriceMinor: targetQuantity * unitPriceMinor,
        status: "LOCKED",
        note,
        lockedAt: lockAt,
      },
    });
    targetRecordId = created.id;
  }

  return { currentTotal, targetRecordId, status: "LOCKED", originalBaseline, beforeRecords };
}
