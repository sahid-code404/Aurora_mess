/**
 * POST /api/v1/admin/calendar/impact — impact preview (spec §44, §147):
 * count meal services that WOULD be disabled over the window, honoring
 * ALL_MEALS vs SELECTED_MEALS without creating instances or saving state.
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
import {
  mealDefinitionIdsSchema,
  mealScopeSchema,
  validateMealScopeSelection,
} from "@/lib/domain/meal-scope";

const bodySchema = z.object({
  startDate: dateKeySchema,
  endDate: dateKeySchema,
  disableMeals: z.boolean().default(true),
  mealScope: mealScopeSchema.default("ALL_MEALS"),
  mealDefinitionIds: mealDefinitionIdsSchema,
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
    if (body.mealScope !== "ALL_MEALS" || (body.mealDefinitionIds?.length ?? 0) > 0) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Meal scope can only be selected when this event disables meals.",
        422
      );
    }
    return {
      data: {
        affectedMealServices: 0,
        perDefinition: [],
        mealScope: "ALL_MEALS",
        selectedMeals: [],
        note: "Meals are not disabled by this event.",
      },
    };
  }

  const selection = await validateMealScopeSelection({
    institutionId: ctx.institutionId,
    mealScope: body.mealScope,
    mealDefinitionIds: body.mealDefinitionIds,
  });

  const defs = await db.mealDefinition.findMany({
    where: {
      institutionId: ctx.institutionId,
      archivedAt: null,
      active: true,
      mealType: { not: "GUEST_ONLY" },
      ...(body.mealScope === "SELECTED_MEALS" ? { id: { in: selection.ids } } : {}),
    },
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
    data: {
      affectedMealServices,
      perDefinition,
      mealScope: body.mealScope,
      selectedMeals: selection.meals,
    },
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
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}
