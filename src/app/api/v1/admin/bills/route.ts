/**
 * GET /api/v1/admin/bills — all bills (auth ADMIN). Filters: periodId, status,
 * q (bill number or resident name). Meta KPIs: total billed (Σ subtotal of
 * non-voided bills), total collected (Σ payments applied), overdue count.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { finishPage, keysetWhere } from "@/lib/domain/http";
import { serializeBill } from "@/lib/domain/serialize";

export const dynamic = "force-dynamic";

const BILL_STATUSES = ["GENERATED", "PARTIALLY_PAID", "PAID", "OVERDUE", "VOIDED"];

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  let periodId = url.searchParams.get("periodId") ?? undefined;
  const month = url.searchParams.get("month") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const q = (url.searchParams.get("q") ?? "").trim();
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  const fields: Record<string, string> = {};
  if (status && !BILL_STATUSES.includes(status)) fields.status = "Unknown bill status filter.";
  if (month && !periodId) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      fields.month = "Months use the YYYY-MM format.";
    } else {
      const p = await db.billingPeriod.findFirst({
        where: { institutionId: ctx.institutionId, year: Number(m[1]), month: Number(m[2]) },
      });
      if (p) {
        periodId = p.id;
      } else {
        return {
          data: [],
          meta: {
            nextCursor: null,
            periodId: null,
            month,
            totalBilled: 0,
            totalBilledFormatted: formatMinor(0),
            totalCollected: 0,
            totalCollectedFormatted: formatMinor(0),
            overdueCount: 0,
          },
        };
      }
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the filters.", 400, fields);
  }
  if (periodId) {
    const period = await db.billingPeriod.findFirst({ where: { id: periodId, institutionId: ctx.institutionId } });
    if (!period) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Unknown billing period.", 400, { periodId: "Unknown billing period." });
    }
  }

  const base: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (periodId) base.billingPeriodId = periodId;
  if (status) base.status = status;
  let searchConditions: Record<string, unknown>[] | null = null;
  if (q) {
    const matched = await db.user.findMany({
      where: {
        institutionId: ctx.institutionId,
        role: "RESIDENT",
        OR: [{ email: { contains: q } }, { profile: { fullName: { contains: q } } }],
      },
      select: { id: true },
      take: 100,
    });
    searchConditions = [{ billNumber: { contains: q } }, { residentId: { in: matched.map((m) => m.id) } }];
  }

  const { where, take } = keysetWhere(base, "generatedAt", cursor, limit);
  if (searchConditions) {
    where.AND = [...((where.AND as Record<string, unknown>[]) ?? []), { OR: searchConditions }];
  }
  const rows = await db.bill.findMany({
    where,
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    take,
    include: { period: { select: { id: true, year: true, month: true, status: true } } },
  });
  const page = finishPage(rows, limit, (row) => row.generatedAt);

  const residentIds = [...new Set(page.items.map((b) => b.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({ where: { userId: { in: residentIds } }, select: { userId: true, fullName: true } })
    : [];
  const nameMap = new Map(profiles.map((p) => [p.userId, p.fullName]));

  const kpiWhere: Record<string, unknown> = {
    institutionId: ctx.institutionId,
    status: { not: "VOIDED" },
    ...(periodId ? { billingPeriodId: periodId } : {}),
  };
  const overdueWhere: Record<string, unknown> = {
    institutionId: ctx.institutionId,
    status: { in: ["GENERATED", "PARTIALLY_PAID", "OVERDUE"] },
    dueDate: { lt: new Date() },
    ...(periodId ? { billingPeriodId: periodId } : {}),
  };

  const [totalBilledAgg, totalCollectedAgg, overdueCount] = await Promise.all([
    db.bill.aggregate({
      _sum: { subtotalMinor: true },
      where: kpiWhere,
    }),
    db.bill.aggregate({
      _sum: { paymentsMinor: true },
      where: kpiWhere,
    }),
    db.bill.count({
      where: overdueWhere,
    }),
  ]);

  const now = new Date();
  const sortedItems = [...page.items].sort((a, b) => {
    const isOverdue = (bill: typeof a) =>
      bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate < now);
    const isActionNeeded = (bill: typeof a) => bill.totalDueMinor > 0;

    const getRank = (bill: typeof a) => {
      if (isOverdue(bill)) return 0; // Past due / Overdue
      if (isActionNeeded(bill)) return 1; // Unsettled (due)
      if (bill.status === "PAID") return 2; // Settled
      return 3; // Voided
    };

    const rA = getRank(a);
    const rB = getRank(b);
    if (rA !== rB) return rA - rB;

    if (rA === 0 || rA === 1) {
      return a.dueDate.getTime() - b.dueDate.getTime();
    }

    return b.generatedAt.getTime() - a.generatedAt.getTime();
  });

  return {
    data: sortedItems.map((b) => ({
      ...serializeBill(b),
      residentName: nameMap.get(b.residentId) ?? "Resident",
    })),
    meta: {
      nextCursor: page.nextCursor,
      periodId: periodId ?? null,
      month: month ?? null,
      totalBilled: totalBilledAgg._sum.subtotalMinor ?? 0,
      totalBilledFormatted: formatMinor(totalBilledAgg._sum.subtotalMinor ?? 0),
      totalCollected: totalCollectedAgg._sum.paymentsMinor ?? 0,
      totalCollectedFormatted: formatMinor(totalCollectedAgg._sum.paymentsMinor ?? 0),
      overdueCount,
    },
  };
});
