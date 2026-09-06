/**
 * POST /api/v1/admin/expenses/[id]/void — void an APPROVED expense (auth ADMIN).
 * Transaction: institution billing mutex → period guard → status guard →
 * REVERSAL journal (Dr CASH / Cr MESS_EXPENSE — the mirror of approval) → audit.
 * Approved expenses are never deleted or edited (spec §41).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { sweepOutbox } from "@/lib/outbox";
import { reasonSchema } from "@/lib/validation";
import { postJournal } from "@/lib/domain/ledger";
import { serializeExpense } from "@/lib/domain/serialize";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import { assertExpensePeriodMutable } from "@/lib/domain/expense-period";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const payload = await db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, ctx.institutionId);

    const expense = await tx.expense.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
      include: { category: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    });
    if (!expense) throw new ApiError(CODES.NOT_FOUND, "Expense not found.", 404);
    if (expense.status === "VOIDED") {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "This expense was already voided.", 409);
    }
    if (expense.status !== "APPROVED") {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "Only approved expenses can be voided.", 409);
    }

    await assertExpensePeriodMutable(tx, ctx.institutionId, expense.date.toISOString().slice(0, 10));

    const guard = await tx.expense.updateMany({
      where: { id: expense.id, status: "APPROVED" },
      data: { status: "VOIDED", voidReason: body.reason, reviewedAt: new Date() },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "This expense was already voided.", 409);
    }

    const { journalId } = await postJournal(
      {
        institutionId: ctx.institutionId,
        refType: "EXPENSE",
        refId: expense.id,
        description: `Reversal — expense ${expense.displayNumber} voided`,
        createdByUserId: ctx.user.id,
        lines: [
          { accountCode: "CASH", debitMinor: expense.totalMinor },
          { accountCode: "MESS_EXPENSE", creditMinor: expense.totalMinor },
        ],
      },
      tx
    );

    await tx.expense.update({ where: { id: expense.id }, data: { reversalJournalId: journalId } });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "EXPENSE_VOIDED",
        entityType: "EXPENSE",
        entityId: expense.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: "APPROVED",
        afterSummary: "VOIDED",
        metadata: {
          totalMinor: expense.totalMinor,
          displayNumber: expense.displayNumber,
          reversalJournalId: journalId,
        },
      },
      tx
    );

    return serializeExpense({ ...expense, status: "VOIDED", reversalJournalId: journalId, voidReason: body.reason });
  });

  sweepOutbox(20).catch(() => {});

  return { data: payload };
});