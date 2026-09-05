/**
 * GET /api/v1/admin/guest-meals?date=YYYY-MM-DD — all guest meals for a date
 * with host names and totals. Time-derived lifecycle states are refreshed
 * before serialization so history cannot remain CONFIRMED after cutoff/service.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { dateKeyInTz, localDateMidnightUtc } from "@/lib/time";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { refreshGuestMealLifecycle } from "@/lib/domain/guest-meal-lifecycle";
import { formatMinor } from "@/lib/money";

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
  const dayStart = localDateMidnightUtc(dateKey);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);

  await refreshGuestMealLifecycle({
    institutionId: ctx.institutionId,
    from: dayStart,
    to: dayEnd,
  });

  const rows = await db.guestMealRequest.findMany({
    where: {
      institutionId: ctx.institutionId,
      mealInstance: { serviceDate: { gte: dayStart, lte: dayEnd } },
    },
    include: { mealInstance: { include: { definition: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const hostIds = rows.map((g) => g.hostResidentId);
  const hosts = hostIds.length
    ? await db.user.findMany({ where: { id: { in: hostIds } }, include: { profile: true } })
    : [];
  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const data = rows.map((g) => {
    const host = hostById.get(g.hostResidentId);
    return {
      id: g.id,
      hostResidentId: g.hostResidentId,
      hostName: host?.profile?.fullName ?? host?.email ?? "Resident",
      roomNumber: host?.profile?.roomNumber ?? null,
      mealInstanceId: g.mealInstanceId,
      mealName: g.mealInstance.definition?.name ?? "Meal",
      serviceDate: keyOfUtcDate(g.mealInstance.serviceDate),
      quantity: g.quantity,
      unitPriceMinor: g.unitPriceMinor,
      totalPriceMinor: g.totalPriceMinor,
      note: g.note,
      status: g.status,
      lockedAt: g.lockedAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
    };
  });

  const sortedData = [...data].sort((a, b) => {
    const getRank = (st: string) => {
      if (st === "REQUESTED" || st === "PENDING") return 0;
      if (st === "CONFIRMED") return 1;
      if (st === "LOCKED") return 2;
      if (st === "CONSUMED") return 3;
      return 4; // CANCELLED
    };
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const active = sortedData.filter((d) => d.status !== "CANCELLED");
  return {
    data: sortedData,
    meta: {
      date: dateKey,
      timezone: tz,
      count: data.length,
      totalQuantity: active.reduce((s, d) => s + d.quantity, 0),
      totalAmountMinor: active.reduce((s, d) => s + d.totalPriceMinor, 0),
      totalAmountLabel: formatMinor(active.reduce((s, d) => s + d.totalPriceMinor, 0)),
    },
  };
});
