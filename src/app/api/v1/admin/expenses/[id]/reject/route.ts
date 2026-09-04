/**
 * POST /api/v1/admin/expenses/[id]/reject — reject a PENDING expense (auth ADMIN).
 * No journal: rejected expenses never entered the books. Reason is audited.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { sweepOutbox } from "@/lib/outbox";
import { reasonSchema } from "@/lib/validation";
import { serializeExpense } from "@/lib/domain/serialize";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const payload = await db.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
      include: { category: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    });
    if (!expense) throw new ApiError(CODES.NOT_FOUND, "Expense not found.", 404);
    if (expense.status !== "PENDING") {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "This expense was already reviewed.", 409);
    }

    const guard = await tx.expense.updateMany({
      where: { id: expense.id, status: "PENDING" },
      data: { status: "REJECTED", reviewedAt: new Date() },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "This expense was already reviewed.", 409);
    }

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "EXPENSE_REJECTED",
        entityType: "EXPENSE",
        entityId: expense.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: "PENDING",
        afterSummary: "REJECTED",
        metadata: { totalMinor: expense.totalMinor, displayNumber: expense.displayNumber },
      },
      tx
    );

    return serializeExpense({ ...expense, status: "REJECTED" });
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
