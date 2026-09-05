import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { finishPage, keysetWhere } from "@/lib/domain/http";
import { formatMinor } from "@/lib/money";
import { serializeRefund } from "@/lib/domain/serialize";
import { getInstitution } from "@/lib/institution";
import { currentPeriodBounds } from "@/lib/domain/formula/period-variables";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/refunds (auth RESIDENT)
 *
 * List refunds and credit adjustments issued for the authenticated resident.
 */
export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  const baseWhere: Record<string, unknown> = {
    institutionId: ctx.institutionId,
    residentId: ctx.user.id,
  };

  const { where, take } = keysetWhere(baseWhere, "createdAt", cursor, limit);
  const rows = await db.refund.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  const page = finishPage(rows, limit, (row) => row.createdAt);

  const inst = await getInstitution(ctx.institutionId);
  const bounds = currentPeriodBounds(inst?.timezone ?? "UTC");
  const [cashThisMonthAgg, cashTotalAgg, carryThisMonthAgg, carryTotalAgg] = await Promise.all([
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        status: "COMPLETED",
        mode: "ISSUE_REFUND",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        status: "COMPLETED",
        mode: "ISSUE_REFUND",
      },
    }),
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        status: "COMPLETED",
        mode: "CARRY_FORWARD",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        status: "COMPLETED",
        mode: "CARRY_FORWARD",
      },
    }),
  ]);

  return {
    data: page.items.map((r) => serializeRefund(r)),
    meta: {
      nextCursor: page.nextCursor,
      refundsThisMonth: cashThisMonthAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(cashThisMonthAgg._sum.amountMinor ?? 0),
      totalRefunded: cashTotalAgg._sum.amountMinor ?? 0,
      totalRefundedFormatted: formatMinor(cashTotalAgg._sum.amountMinor ?? 0),
      carriedForwardThisMonth: carryThisMonthAgg._sum.amountMinor ?? 0,
      carriedForwardThisMonthFormatted: formatMinor(carryThisMonthAgg._sum.amountMinor ?? 0),
      totalCarriedForward: carryTotalAgg._sum.amountMinor ?? 0,
      totalCarriedForwardFormatted: formatMinor(carryTotalAgg._sum.amountMinor ?? 0),
    },
  };
});
