/**
 * GET /api/v1/bills — the resident's own bills (auth RESIDENT), status != VOIDED,
 * newest first with lines + period. Meta: overdue count and derived payment
 * status ("Overdue" | "Due" | "Settled").
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { finishPage, keysetWhere } from "@/lib/domain/http";
import { derivePaymentStatus } from "@/lib/domain/billing";
import { serializeBill } from "@/lib/domain/serialize";
import { currentLocalDateMarker, effectiveBillStatus } from "@/lib/domain/bill-status";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const now = new Date();
  const todayMarker = currentLocalDateMarker(timeZone, now);

  const { where, take } = keysetWhere(
    { residentId: ctx.user.id, status: { not: "VOIDED" } },
    "generatedAt",
    cursor,
    limit
  );
  const rows = await db.bill.findMany({
    where,
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    take,
    include: {
      period: { select: { id: true, year: true, month: true, status: true } },
      lines: { orderBy: { sortOrder: "asc" } },
    },
  });
  const page = finishPage(rows, limit, (row) => row.generatedAt);

  // Status derivation over ALL my unsettled bills (not just this page).
  const unsettled = await db.bill.findMany({
    where: { residentId: ctx.user.id, status: { in: ["GENERATED", "PARTIALLY_PAID", "OVERDUE"] } },
    select: { status: true, dueDate: true },
  });
  const overdueCount = unsettled.filter((b) => b.dueDate < todayMarker).length;
  const paymentStatus = derivePaymentStatus(unsettled, timeZone, now);

  const sortedItems = [...page.items].sort((a, b) => {
    const isOverdue = (bill: typeof a) => bill.totalDueMinor > 0 && bill.dueDate < todayMarker;
    const isActionNeeded = (bill: typeof a) => bill.totalDueMinor > 0;

    const getRank = (bill: typeof a) => {
      if (isOverdue(bill)) return 0; // Past due / Overdue (urgent action)
      if (isActionNeeded(bill)) return 1; // Unsettled (needs payment)
      return 2; // Settled
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
      status: effectiveBillStatus(b, timeZone, now),
    })),
    meta: {
      nextCursor: page.nextCursor,
      overdueCount,
      paymentStatus,
    },
  };
});
