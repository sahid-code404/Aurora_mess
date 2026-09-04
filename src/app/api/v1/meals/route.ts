/**
 * GET /api/v1/meals — the resident meal calendar (spec §26).
 * Lazy materialization → ensureInstances → ensureResidentMeals → refreshAndLock
 * → joined read. Default range: today ±7d, max 62 days. Per-day grouping is
 * done client-side; this endpoint returns a flat, chronologically sorted list.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { addDaysToKey, dateKeyInTz, localDateMidnightUtc, monthBoundsInTz } from "@/lib/time";
import {
  dayCountBetween,
  ensureInstancesForRange,
  ensureResidentMeals,
  refreshAndLock,
  refreshUnlockedEffective,
  requireInstitutionContext,
  serializeMealInstance,
} from "@/lib/domain/meal-engine";

const querySchema = z.object({
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const todayKey = dateKeyInTz(new Date(), tz);

  const raw: Record<string, string> = {};
  for (const [k, v] of ctx.req.nextUrl.searchParams.entries()) raw[k] = v;
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".")] = issue.message;
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the date filters.", 400, fields);
  }

  const from = parsed.data.from ?? addDaysToKey(todayKey, -7);
  const to = parsed.data.to ?? addDaysToKey(todayKey, 7);
  if (from > to) {
    throw new ApiError(CODES.VALIDATION_FAILED, "The start date must be on or before the end date.", 400, {
      from: "Start date is after the end date.",
    });
  }
  if (dayCountBetween(from, to) > 62) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please choose a range of 62 days or fewer.", 400);
  }

  await ensureInstancesForRange(ctx.institutionId, tz, from, to);
  await ensureResidentMeals(ctx.user.id, ctx.institutionId, tz, from, to);
  await refreshAndLock(ctx.institutionId, tz, ctx.user.id, from, to);
  // Live re-evaluation of unlocked rows (calendar/leave/policy reflect on read).
  await refreshUnlockedEffective(ctx.institutionId, ctx.user.id, from, to);

  const rows = await db.residentMeal.findMany({
    where: {
      residentId: ctx.user.id,
      mealInstance: { serviceDate: { gte: localDateMidnightUtc(from), lte: localDateMidnightUtc(to) } },
    },
    include: { mealInstance: { include: { definition: true } } },
  });

  rows.sort((a, b) => {
    const da = new Date(a.mealInstance.serviceDate).getTime();
    const ddb = new Date(b.mealInstance.serviceDate).getTime();
    if (da !== ddb) return da - ddb;
    return new Date(a.mealInstance.serviceStartAt).getTime() - new Date(b.mealInstance.serviceStartAt).getTime();
  });

  const meals = rows.map((rm) => {
    const base = serializeMealInstance(rm.mealInstance as never, rm.mealInstance.definition as never);
    return {
      ...base,
      myState: {
        residentMealId: rm.id,
        effectiveState: rm.effectiveState,
        effectiveReason: rm.effectiveReason,
        locked: rm.lockedAt != null,
        version: rm.version,
        overridden: rm.effectiveReason === "ADMIN_OVERRIDE",
      },
    };
  });

  // Month-to-date counters for the resident (current institution month).
  const month = monthBoundsInTz(new Date(), tz);
  const monthStart = localDateMidnightUtc(month.startKey);
  const monthEnd = localDateMidnightUtc(month.endKey);
  const now = new Date();

  // Confirmed/locked/override filter: excludes unconfirmed future meals before cutoff
  const confirmedWhereOn = {
    residentId: ctx.user.id,
    effectiveState: "ON",
    mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "ON" },
      { mealInstance: { cutoffAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };

  const confirmedWhereOff = {
    residentId: ctx.user.id,
    effectiveState: "OFF",
    mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "OFF" },
      { mealInstance: { cutoffAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };

  const [mealsOnMonth, mealsOffMonth] = await Promise.all([
    db.residentMeal.count({ where: confirmedWhereOn }),
    db.residentMeal.count({ where: confirmedWhereOff }),
  ]);

  return {
    data: meals,
    meta: {
      from,
      to,
      today: todayKey,
      timezone: tz,
      monthKey: `${month.year}-${String(month.month).padStart(2, "0")}`,
      mealsOnMonth,
      mealsOffMonth,
      serverTime: new Date().toISOString(),
    },
  };
});
