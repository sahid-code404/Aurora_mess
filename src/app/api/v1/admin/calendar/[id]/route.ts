/**
 * DELETE /api/v1/admin/calendar/[id] — cancel a calendar event with provenance.
 *
 * Cancellation affects current/future unlocked meal evaluation immediately, but
 * the event row and meal-scope selections are retained so lazy historical meal
 * locking can reconstruct whether the event was active at each meal's lockAt.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { reasonSchema } from "@/lib/validation";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";

const bodySchema = z.object({ reason: reasonSchema });

export const DELETE = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    const event = await tx.calendarEvent.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!event) throw new ApiError(CODES.NOT_FOUND, "This calendar event could not be found.", 404);
    if (event.cancelledAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This calendar event is already cancelled.", 409);
    }

    const now = new Date();
    const guard = await tx.calendarEvent.updateMany({
      where: {
        id: event.id,
        institutionId: ctx.institutionId,
        cancelledAt: null,
      },
      data: {
        cancelledAt: now,
        cancelledByUserId: ctx.user.id,
        cancelReason: body.reason,
      },
    });
    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This calendar event was cancelled just now. Refresh to see its latest state.",
        409
      );
    }

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "CALENDAR_EVENT_CANCELLED",
        entityType: "CALENDAR_EVENT",
        entityId: event.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({
          status: "ACTIVE",
          name: event.name,
          type: event.type,
          startDate: keyOfUtcDate(event.startDate),
          endDate: keyOfUtcDate(event.endDate),
          disableMeals: event.disableMeals,
        }),
        afterSummary: JSON.stringify({
          status: "CANCELLED",
          cancelledAt: now.toISOString(),
        }),
      },
      tx
    );

    return { id: event.id, name: event.name, cancelledAt: now };
  });

  return {
    data: {
      id: result.id,
      name: result.name,
      cancelled: true,
      cancelledAt: result.cancelledAt.toISOString(),
    },
  };
});