/**
 * GET /api/v1/admin/payments — institution payment queue (auth ADMIN).
 * Filters: status, q (display number / reference / resident name or email).
 * Keyset cursor on submittedAt. Meta KPIs: received this month (approved),
 * pending approval, refunds completed this month.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { finishPage, keysetWhere } from "@/lib/domain/http";
import { serializePayment } from "@/lib/domain/serialize";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";

export const dynamic = "force-dynamic";

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"];

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = (url.searchParams.get("q") ?? "").trim();
  const month = url.searchParams.get("month") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  if (status && !STATUSES.includes(status)) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Unknown payment status filter.", 400);
  }

  let monthYear: { year: number; month: number } | null = null;
  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Months use the YYYY-MM format.", 400);
    } else {
      monthYear = { year: Number(m[1]), month: Number(m[2]) };
    }
  }

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = monthYear ? periodBounds(monthYear.year, monthYear.month, tz) : currentPeriodBounds(tz);

  const base: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (status) base.status = status;
  if (monthYear) {
    base.submittedAt = { gte: bounds.startInstant, lt: bounds.endInstant };
  }

  let searchConditions: Record<string, unknown>[] | null = null;
  if (q) {
    // Resident search resolves names/emails first (no relations on Payment).
    const matched = await db.user.findMany({
      where: {
        institutionId: ctx.institutionId,
        role: "RESIDENT",
        OR: [{ email: { contains: q } }, { profile: { fullName: { contains: q } } }],
      },
      select: { id: true },
      take: 100,
    });
    searchConditions = [
      { displayNumber: { contains: q } },
      { reference: { contains: q } },
      { residentId: { in: matched.map((m) => m.id) } },
    ];
  }

  const { where, take } = keysetWhere(base, "submittedAt", cursor, limit);
  if (searchConditions) {
    where.AND = [...((where.AND as Record<string, unknown>[]) ?? []), { OR: searchConditions }];
  }
  const rows = await db.payment.findMany({ where, orderBy: [{ submittedAt: "desc" }, { id: "desc" }], take });
  const page = finishPage(rows, limit, (row) => row.submittedAt);

  const residentIds = [...new Set(page.items.map((p) => p.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({ where: { userId: { in: residentIds } }, select: { userId: true, fullName: true } })
    : [];
  const nameMap = new Map(profiles.map((p) => [p.userId, p.fullName]));

  const [receivedAgg, pendingCount, refundsAgg, carryForwardAgg, generatedBillCount] = await Promise.all([
    db.payment.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },
        submittedAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.payment.count({ where: { institutionId: ctx.institutionId, status: "PENDING" } }),
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        status: "COMPLETED",
        mode: "ISSUE_REFUND",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        status: "COMPLETED",
        mode: "CARRY_FORWARD",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.bill.count({
      where: { institutionId: ctx.institutionId, status: { not: "VOIDED" } },
    }),
  ]);

  const sortedItems = [...page.items].sort((a, b) => {
    const pA = a.status === "PENDING" ? 0 : 1;
    const pB = b.status === "PENDING" ? 0 : 1;
    if (pA !== pB) return pA - pB;
    return b.submittedAt.getTime() - a.submittedAt.getTime();
  });

  return {
    data: sortedItems.map((p) => ({
      ...serializePayment(p),
      residentId: p.residentId,
      residentName: nameMap.get(p.residentId) ?? "Resident",
    })),
    meta: {
      nextCursor: page.nextCursor,
      month: bounds.key,
      receivedThisMonth: receivedAgg._sum.amountMinor ?? 0,
      receivedThisMonthFormatted: formatMinor(receivedAgg._sum.amountMinor ?? 0),
      pendingApproval: pendingCount,
      // Refund KPIs are cash outflow only. Carry-forward is retained resident credit.
      refundsThisMonth: refundsAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(refundsAgg._sum.amountMinor ?? 0),
      carriedForwardThisMonth: carryForwardAgg._sum.amountMinor ?? 0,
      carriedForwardThisMonthFormatted: formatMinor(carryForwardAgg._sum.amountMinor ?? 0),
      hasGeneratedBills: generatedBillCount > 0,
    },
  };
});
