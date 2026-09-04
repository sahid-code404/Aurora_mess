/**
 * POST /api/v1/admin/expenses/[id]/approve — approve a PENDING expense (auth ADMIN).
 * Transaction: status guard → journal Dr MESS_EXPENSE / Cr CASH → audit.
 * Approved expenses are immutable; voiding posts a reversal (never a delete).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { sweepOutbox } from "@/lib/outbox";
import { postJournal } from "@/lib/domain/ledger";
import { serializeExpense } from "@/lib/domain/serialize";

export const dynamic = "force-dynamic";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const payload = await db.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
      include: { category: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    });
    if (!expense) throw new ApiError(CODES.NOT_FOUND, "Expense not found.", 404);
    if (expense.status !== "PENDING") {
      throw new ApiError(
        CODES.EXPENSE_INVALID_STATE,
        expense.status === "APPROVED"
          ? "This expense was already approved — void it instead if it's wrong."
          : "This expense was already reviewed.",
        409
      );
    }

    const guard = await tx.expense.updateMany({
      where: { id: expense.id, status: "PENDING" },
      data: { status: "APPROVED", reviewedAt: new Date(), approvedByUserId: ctx.user.id },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "This expense was already reviewed.", 409);
    }

    const { journalId } = await postJournal(
      {
        institutionId: ctx.institutionId,
        refType: "EXPENSE",
        refId: expense.id,
        description: `Expense ${expense.displayNumber} approved — ${expense.description}`.slice(0, 190),
        createdByUserId: ctx.user.id,
        lines: [
          { accountCode: "MESS_EXPENSE", debitMinor: expense.totalMinor },
          { accountCode: "CASH", creditMinor: expense.totalMinor },
        ],
      },
      tx
    );

    await tx.expense.update({ where: { id: expense.id }, data: { journalId } });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "EXPENSE_APPROVED",
        entityType: "EXPENSE",
        entityId: expense.id,
        requestId: ctx.requestId,
        beforeSummary: "PENDING",
        afterSummary: "APPROVED",
        metadata: {
          totalMinor: expense.totalMinor,
          displayNumber: expense.displayNumber,
          journalId,
          itemCount: expense._count.items,
        },
      },
      tx
    );

    return serializeExpense({ ...expense, status: "APPROVED", journalId });
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});
