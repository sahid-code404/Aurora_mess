/**
 * POST /api/v1/admin/calendar/impact — impact preview (spec §147):
 * how many meal services WOULD be disabled by a disableMeals event over the
 * window. Counted from ACTIVE definitions × matching dates — no instances are
 * created and nothing is saved.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { addDaysToKey } from "@/lib/time";
import {
  dayCountBetween,
  keyOfUtcDate,
  parseWeekdaysCsv,
  requireInstitutionContext,
} from "@/lib/domain/meal-engine";

const bodySchema = z.object({
  startDate: dateKeySchema,
  endDate: dateKeySchema,
  disableMeals: z.boolean().default(true),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  if (body.endDate < body.startDate) {
    throw new ApiError(CODES.VALIDATION_FAILED, "The end date must be on or after the start date.", 400, {
      endDate: "End date is before the start date.",
    });
  }
  if (dayCountBetween(body.startDate, body.endDate) > 366) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Preview windows can span at most 366 days.", 400);
  }

  if (!body.disableMeals) {
    return { data: { affectedMealServices: 0, note: "Meals are not disabled by this event." } };
  }

  const defs = await db.mealDefinition.findMany({
    where: { institutionId: ctx.institutionId, archivedAt: null },
    select: {
      id: true,
      name: true,
      scheduleStrategy: true,
      weekdaysCsv: true,
      specificDate: true,
    },
  });

  let affectedMealServices = 0;
  const perDefinition: { id: string; name: string; count: number }[] = [];
  const dates: string[] = [];
  for (let k = body.startDate; k <= body.endDate && dates.length < 400; k = addDaysToKey(k, 1)) dates.push(k);

  for (const def of defs) {
    const weekdays = parseWeekdaysCsv(def.weekdaysCsv);
    const oneTimeKey = def.specificDate ? keyOfUtcDate(def.specificDate) : null;
    let count = 0;
    for (const dateKey of dates) {
      if (def.scheduleStrategy === "WEEKDAYS" && !weekdays.has(getWeekday(dateKey))) continue;
      if (def.scheduleStrategy === "ONE_TIME" && oneTimeKey !== dateKey) continue;
      count++;
    }
    affectedMealServices += count;
    perDefinition.push({ id: def.id, name: def.name, count });
  }

  return {
    data: { affectedMealServices, perDefinition },
    meta: {
      startDate: body.startDate,
      endDate: body.endDate,
      dayCount: dates.length,
      definitionCount: defs.length,
    },
  };
});

function getWeekday(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return jsDay === 0 ? 7 : jsDay;
}
