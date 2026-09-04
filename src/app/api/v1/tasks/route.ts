/**
 * GET /api/v1/tasks — the resident's own market tasks with items + submission
 * (and submission items), newest first, seek pagination; meta counts by status.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { requireInstitutionContext, keyOfUtcDate } from "@/lib/domain/meal-engine";
import { listQuery, seekList } from "@/lib/domain/list";

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const { limit, cursor } = listQuery(ctx.req.nextUrl.searchParams);

  const { items, nextCursor } = await seekList({
    client: db,
    model: "task",
    where: { institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    limit,
    cursor,
    include: {
      items: { orderBy: [{ itemName: "asc" }] },
      submission: { include: { items: true } },
    },
  });

  const data = items.map((t) => ({
    id: t.id,
    taskType: t.taskType,
    description: t.description,
    dueDate: t.dueDate ? keyOfUtcDate(t.dueDate) : null,
    notes: t.notes ?? null,
    estimatedAmountMinor: t.estimatedAmountMinor ?? null,
    status: t.status,
    rejectionReason: t.rejectionReason ?? null,
    adminReviewReason: t.adminReviewReason ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    items: (t.items ?? []).map((i) => ({
      id: i.id,
      itemName: i.itemName,
      expectedQuantity: i.expectedQuantity ?? null,
      unit: i.unit,
      estimatedUnitPriceMinor: i.estimatedUnitPriceMinor ?? null,
    })),
    submission: t.submission
      ? {
          id: t.submission.id,
          status: t.submission.status,
          comment: t.submission.comment ?? null,
          claimedTotalMinor: t.submission.claimedTotalMinor,
          expenseId: t.submission.expenseId ?? null,
          proofFileId: t.submission.proofFileId ?? null,
          submittedAt: t.submission.submittedAt.toISOString(),
          reviewedAt: t.submission.reviewedAt ? t.submission.reviewedAt.toISOString() : null,
          reviewReason: t.submission.reviewReason ?? null,
          items: (t.submission.items ?? []).map((si) => ({
            id: si.id,
            itemName: si.itemName,
            quantity: si.quantity,
            unit: si.unit,
            unitPriceMinor: si.unitPriceMinor,
            lineTotalMinor: si.lineTotalMinor,
          })),
        }
      : null,
  }));

  const statusGroups = await db.task.groupBy({
    by: ["status"],
    where: { institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    _count: { _all: true },
  });
  const countsByStatus: Record<string, number> = {};
  for (const g of statusGroups) countsByStatus[g.status] = g._count._all;

  const sortedData = [...data].sort((a, b) => {
    const getRank = (st: string) => {
      if (st === "ASSIGNED") return 0; // Needs resident action: accept or reject
      if (st === "ACCEPTED" || st === "IN_PROGRESS") return 1; // Needs resident action: execute & submit
      if (st === "SUBMITTED") return 2; // In review
      return 3; // Finished / Rejected
    };
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;

    if (rA === 0 || rA === 1) {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return { data: sortedData, meta: { cursor: nextCursor, limit, countsByStatus, total: Object.values(countsByStatus).reduce((s, n) => s + n, 0) } };
});
