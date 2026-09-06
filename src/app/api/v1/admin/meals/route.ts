/**
 * GET /api/v1/admin/meals?date=YYYY-MM-DD — the admin day sheet (spec §27).
 * Materializes the day for every ACTIVE resident, freezes meals whose
 * authoritative lock boundary has passed, then returns per-instance counts +
 * the full resident roster with today's states and month-to-date ON counts.
 * Big response is fine (≤200 residents).
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { dateKeyInTz, localDateMidnightUtc, monthBoundsInTz } from "@/lib/time";
import {
  ensureInstancesForRange,
  ensureResidentMeals,
  keyOfUtcDate,
  refreshAndLock,
  refreshUnlockedEffective,
  requireInstitutionContext,
} from "@/lib/domain/meal-engine";

const querySchema = z.object({ date: dateKeySchema.optional() });

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const todayKey = dateKeyInTz(new Date(), tz);

  const raw: Record<string, string> = {};
  for (const [k, v] of ctx.req.nextUrl.searchParams.entries()) raw[k] = v;
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Dates use the YYYY-MM-DD format.", 400, {
      date: "Dates use the YYYY-MM-DD format.",
    });
  }
  const dateKey = parsed.data.date ?? todayKey;

  await ensureInstancesForRange(ctx.institutionId, tz, dateKey, dateKey);

  const residents = await db.user.findMany({
    where: { institutionId: ctx.institutionId, role: "RESIDENT", status: "ACTIVE" },
    include: { profile: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const resident of residents) {
    await ensureResidentMeals(resident.id, ctx.institutionId, tz, dateKey, dateKey);
  }
  await refreshAndLock(ctx.institutionId, tz, null, dateKey, dateKey);
  // Live re-evaluation of unlocked rows for the whole roster (calendar/leave/policy).
  await refreshUnlockedEffective(ctx.institutionId, null, dateKey, dateKey);

  const dayStart = localDateMidnightUtc(dateKey);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  const instances = await db.mealInstance.findMany({
    where: { institutionId: ctx.institutionId, serviceDate: { gte: dayStart, lte: dayEnd } },
    include: { definition: true },
  });
  instances.sort(
    (a, b) => new Date(a.serviceStartAt).getTime() - new Date(b.serviceStartAt).getTime()
  );
  const instanceIds = instances.map((i) => i.id);

  // Per-instance state counts + guest totals.
  const stateGroups = instanceIds.length
    ? await db.residentMeal.groupBy({
        by: ["mealInstanceId", "effectiveState"],
        where: { mealInstanceId: { in: instanceIds } },
        _count: { _all: true },
      })
    : [];

  const todayGuestRequests = instanceIds.length
    ? await db.guestMealRequest.findMany({
        where: {
          institutionId: ctx.institutionId,
          mealInstanceId: { in: instanceIds },
        },
        select: {
          id: true,
          hostResidentId: true,
          mealInstanceId: true,
          quantity: true,
          status: true,
          note: true,
        },
      })
    : [];

  const countFor = (instanceId: string, state: string) =>
    stateGroups
      .filter((g) => g.mealInstanceId === instanceId && g.effectiveState === state)
      .reduce((s, g) => s + g._count._all, 0);
  const guestsFor = (instanceId: string) =>
    todayGuestRequests
      .filter((g) => g.mealInstanceId === instanceId && g.status !== "CANCELLED")
      .reduce((s, g) => s + g.quantity, 0);

  // Resident roster with today's rows.
  const rms = instanceIds.length
    ? await db.residentMeal.findMany({ where: { mealInstanceId: { in: instanceIds } } })
    : [];
  const rmsByResident = new Map<string, typeof rms>();
  for (const rm of rms) {
    const list = rmsByResident.get(rm.residentId) ?? [];
    list.push(rm);
    rmsByResident.set(rm.residentId, list);
  }

  const month = monthBoundsInTz(new Date(), tz);
  const monthStart = localDateMidnightUtc(month.startKey);
  const monthEnd = localDateMidnightUtc(month.endKey);
  const now = new Date();
  // Confirmed/locked/override condition (spec §8 & lock-boundary rule):
  // Counts only meals that are frozen at lockAt, persisted as locked, or
  // explicitly overridden. Excludes future/open meals before lockAt.
  const confirmedOnFilter = {
    effectiveState: "ON",
    mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "ON" },
      { mealInstance: { lockAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };

  const confirmedOffFilter = {
    effectiveState: "OFF",
    mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "OFF" },
      { mealInstance: { lockAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };

  const residentIds = residents.map((r) => r.id);
  const monthlyGroups = residentIds.length
    ? await db.residentMeal.groupBy({
        by: ["residentId"],
        where: {
          residentId: { in: residentIds },
          ...confirmedOnFilter,
        },
        _count: { _all: true },
      })
    : [];
  const monthlyByResident = new Map(monthlyGroups.map((g) => [g.residentId, g._count._all]));

  const monthlyGuestGroups = residentIds.length
    ? await db.guestMealRequest.groupBy({
        by: ["hostResidentId"],
        where: {
          institutionId: ctx.institutionId,
          hostResidentId: { in: residentIds },
          status: { not: "CANCELLED" },
          mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
        },
        _sum: { quantity: true },
      })
    : [];
  const monthlyGuestsByResident = new Map(
    monthlyGuestGroups.map((g) => [g.hostResidentId, g._sum.quantity ?? 0])
  );

  const instanceById = new Map(instances.map((i) => [i.id, i]));

  const roster = residents.map((r) => {
    const own = (rmsByResident.get(r.id) ?? []).slice();
    own.sort(
      (a, b) =>
        new Date(instanceById.get(a.mealInstanceId)?.serviceStartAt ?? 0).getTime() -
        new Date(instanceById.get(b.mealInstanceId)?.serviceStartAt ?? 0).getTime()
    );
    const residentGuests = todayGuestRequests.filter((g) => g.hostResidentId === r.id);
    const activeResidentGuests = residentGuests.filter((g) => g.status !== "CANCELLED");
    const todayGuestCount = activeResidentGuests.reduce((s, g) => s + g.quantity, 0);
    const todayMealCount = own.filter((rm) => rm.effectiveState === "ON").length;

    return {
      residentId: r.id,
      fullName: r.profile?.fullName ?? r.email,
      roomNumber: r.profile?.roomNumber ?? null,
      monthlyMealCount: monthlyByResident.get(r.id) ?? 0,
      monthlyGuestCount: monthlyGuestsByResident.get(r.id) ?? 0,
      todayMealCount,
      todayGuestCount,
      today: own.map((rm) => {
        const instRow = instanceById.get(rm.mealInstanceId);
        const mGuests = residentGuests.filter((g) => g.mealInstanceId === rm.mealInstanceId);
        const activeGuests = mGuests.filter((g) => g.status !== "CANCELLED");
        const guestCount = activeGuests.reduce((s, g) => s + g.quantity, 0);
        // Parse the original user-set baseline from the admin-override note.
        // Format: "Admin override|orig:X" — if current qty matches the original
        // baseline, hide the badge (admin reset it back to the user's value).
        let guestOverridden = false;
        let guestOverrideCount = 0;
        for (const g of mGuests) {
          const match = g.note?.match(/Admin override\|orig:(\d+)/);
          if (match) {
            const originalBaseline = parseInt(match[1], 10);
            guestOverrideCount = Math.abs(guestCount - originalBaseline);
            guestOverridden = guestOverrideCount > 0;
            break;
          }
          // Backward compat: old records may just have "Admin override" without orig
          if (g.note === "Admin override" || g.note?.startsWith("Admin override")) {
            guestOverridden = true;
            guestOverrideCount = guestCount; // best effort
            break;
          }
        }
        return {
          mealInstanceId: rm.mealInstanceId,
          residentMealId: rm.id,
          name: instRow?.definition?.name ?? "Meal",
          effectiveState: rm.effectiveState,
          effectiveReason: rm.effectiveReason,
          baselineState: rm.baselineState,
          residentSelectedState: rm.residentSelectedState,
          adminOverrideState: rm.adminOverrideState,
          overridden: rm.effectiveReason === "ADMIN_OVERRIDE",
          locked: rm.lockedAt != null,
          version: rm.version,
          guestCount,
          guestOverridden,
          guestOverrideCount,
        };
      }),
    };
  });

  // Month KPIs (institution-wide, from materialized rows).
  const [totalMealsThisMonth, mealsOffThisMonth, guestMonthAgg] = await Promise.all([
    db.residentMeal.count({ where: { institutionId: ctx.institutionId, ...confirmedOnFilter } }),
    db.residentMeal.count({ where: { institutionId: ctx.institutionId, ...confirmedOffFilter } }),
    db.guestMealRequest.aggregate({
      where: {
        institutionId: ctx.institutionId,
        status: { in: ["CONFIRMED", "LOCKED", "CONSUMED"] },
        mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
      },
      _sum: { quantity: true },
    }),
  ]);

  return {
    data: {
      date: dateKey,
      timezone: tz,
      instances: instances.map((i) => ({
        instance: {
          id: i.id,
          serviceDate: keyOfUtcDate(i.serviceDate),
          serviceWindow: { startAt: i.serviceStartAt.toISOString(), endAt: i.serviceEndAt.toISOString() },
          cutoffAt: i.cutoffAt.toISOString(),
          lockAt: i.lockAt.toISOString(),
          status: i.status,
        },
        definition: {
          name: i.definition?.name ?? "Meal",
          icon: i.definition?.icon ?? null,
          colorToken: i.definition?.colorToken ?? null,
          mealType: i.definition?.mealType ?? "REGULAR",
        },
        counts: {
          confirmed: countFor(i.id, "ON"),
          off: countFor(i.id, "OFF"),
          guests: guestsFor(i.id),
          onLeave: countFor(i.id, "ON_LEAVE"),
          notAvailable: countFor(i.id, "NOT_AVAILABLE"),
        },
      })),
      residents: roster,
    },
    meta: {
      date: dateKey,
      totalMealsThisMonth,
      guestMealsThisMonth: guestMonthAgg._sum.quantity ?? 0,
      mealsOffThisMonth,
      residentCount: residents.length,
      serverTime: new Date().toISOString(),
    },
  };
});
