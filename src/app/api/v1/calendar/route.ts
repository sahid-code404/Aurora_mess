/**
 * GET /api/v1/calendar?from&to — calendar events for residents AND admins
 * (auth "ANY"). Events drive the meal engine's CALENDAR_DISABLED precedence
 * step. Dates are date keys; stored as local-date-midnight-UTC markers.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { addDaysToKey, dateKeyInTz, localDateMidnightUtc } from "@/lib/time";
import { dayCountBetween, keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { serializeSelectedMeals } from "@/lib/domain/meal-scope";

const querySchema = z.object({
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const todayKey = dateKeyInTz(new Date(), tz);

  const raw: Record<string, string> = {};
  for (const [k, v] of ctx.req.nextUrl.searchParams.entries()) raw[k] = v;
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the date filters.", 400, {
      from: "Dates use the YYYY-MM-DD format.",
      to: "Dates use the YYYY-MM-DD format.",
    });
  }
  const from = parsed.data.from ?? addDaysToKey(todayKey, -7);
  const to = parsed.data.to ?? addDaysToKey(todayKey, 60);
  if (from > to || dayCountBetween(from, to) > 366) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please choose a valid range of 366 days or fewer.", 400);
  }

  const rows = await db.calendarEvent.findMany({
    where: {
      institutionId: ctx.institutionId,
      startDate: { lte: localDateMidnightUtc(to) },
      endDate: { gte: localDateMidnightUtc(from) },
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
    include: {
      selectedMeals: {
        include: { mealDefinition: { select: { id: true, name: true } } },
      },
    },
  });

  return {
    data: rows.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description ?? null,
      startDate: keyOfUtcDate(e.startDate),
      endDate: keyOfUtcDate(e.endDate),
      type: e.type,
      disableMeals: e.disableMeals,
      ...serializeSelectedMeals(e.mealScope, e.selectedMeals),
      createdAt: e.createdAt.toISOString(),
    })),
    meta: { from, to, timezone: tz, today: todayKey },
  };
});
