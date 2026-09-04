/**
 * DELETE /api/v1/admin/calendar/[id] — remove a calendar event (+audit).
 * Meals previously disabled by the event become available again on the next
 * lazy evaluation (read/lock) — the engine always recomputes from live rows.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";

export const DELETE = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const result = await db.$transaction(async (tx) => {
    const event = await tx.calendarEvent.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
    });
    if (!event) throw new ApiError(CODES.NOT_FOUND, "This calendar event could not be found.", 404);

    await tx.calendarEvent.delete({ where: { id: event.id } });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "CALENDAR_EVENT_DELETED",
        entityType: "CALENDAR_EVENT",
        entityId: event.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({
          name: event.name,
          type: event.type,
          startDate: keyOfUtcDate(event.startDate),
          endDate: keyOfUtcDate(event.endDate),
          disableMeals: event.disableMeals,
        }),
        afterSummary: null,
      },
      tx
    );

    return event;
  });

  return {
    data: {
      id: result.id,
      name: result.name,
      deleted: true,
    },
  };
});
