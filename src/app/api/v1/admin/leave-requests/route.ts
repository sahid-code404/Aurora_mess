/**
 * GET /api/v1/admin/leave-requests?status=PENDING — review queue with resident
 * names, selected meal scope, and scope-aware preview counts.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { requireInstitutionContext, keyOfUtcDate, dayCountBetween } from "@/lib/domain/meal-engine";
import { mealInstanceScopeWhere, serializeSelectedMeals } from "@/lib/domain/meal-scope";
import { listQuery, seekList } from "@/lib/domain/list";

const statusEnum = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const { limit, cursor } = listQuery(ctx.req.nextUrl.searchParams);

  const statusRaw = ctx.req.nextUrl.searchParams.get("status") ?? undefined;
  const status = statusEnum.safeParse(statusRaw);
  const where: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (status.success) where.status = status.data;

  const { items, nextCursor } = await seekList({
    client: db,
    model: "leaveRequest",
    where,
    limit,
    cursor,
  });

  const residentIds = items.map((l) => l.residentId);
  const leaveIds = items.map((l) => l.id);
  const residents = residentIds.length
    ? await db.user.findMany({ where: { id: { in: residentIds } }, include: { profile: true } })
    : [];
  const selections = leaveIds.length
    ? await db.leaveRequestMeal.findMany({
        where: { leaveRequestId: { in: leaveIds } },
        include: { mealDefinition: { select: { id: true, name: true } } },
      })
    : [];

  const residentById = new Map(residents.map((resident) => [resident.id, resident] as const));
  const selectionsByLeave = new Map<string, typeof selections>();
  for (const selection of selections) {
    const current = selectionsByLeave.get(selection.leaveRequestId) ?? [];
    current.push(selection);
    selectionsByLeave.set(selection.leaveRequestId, current);
  }

  const now = new Date();
  const data = await Promise.all(
    items.map(async (leave) => {
      const resident = residentById.get(leave.residentId);
      const startKey = keyOfUtcDate(leave.startDate);
      const endKey = keyOfUtcDate(leave.endDate);
      const selectedRows = selectionsByLeave.get(leave.id) ?? [];
      const scopeWhere = mealInstanceScopeWhere(
        leave.mealScope,
        selectedRows.map((selection) => selection.mealDefinitionId)
      );
      const [futureUnlockedMeals, alreadyLockedMeals] = await Promise.all([
        db.mealInstance.count({
          where: {
            institutionId: ctx.institutionId,
            serviceDate: { gte: leave.startDate, lte: leave.endDate },
            ...scopeWhere,
            lockAt: { gt: now },
          },
        }),
        db.mealInstance.count({
          where: {
            institutionId: ctx.institutionId,
            serviceDate: { gte: leave.startDate, lte: leave.endDate },
            ...scopeWhere,
            lockAt: { lte: now },
          },
        }),
      ]);
      return {
        id: leave.id,
        residentId: leave.residentId,
        residentName: resident?.profile?.fullName ?? resident?.email ?? "Resident",
        roomNumber: resident?.profile?.roomNumber ?? null,
        startDate: startKey,
        endDate: endKey,
        dayCount: dayCountBetween(startKey, endKey),
        reason: leave.reason,
        status: leave.status,
        ...serializeSelectedMeals(leave.mealScope, selectedRows),
        reviewReason: leave.reviewReason,
        reviewedAt: leave.reviewedAt ? leave.reviewedAt.toISOString() : null,
        createdAt: leave.createdAt.toISOString(),
        preview: { futureUnlockedMeals, alreadyLockedMeals },
      };
    })
  );

  const pendingCount = await db.leaveRequest.count({
    where: { institutionId: ctx.institutionId, status: "PENDING" },
  });

  const sortedData = [...data].sort((a, b) => {
    const getRank = (st: string) => (st === "PENDING" ? 0 : 1);
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return { data: sortedData, meta: { cursor: nextCursor, limit, pendingCount } };
});