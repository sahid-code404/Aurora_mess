/**
 * POST /api/v1/admin/task-submissions/[id]/approve — THE money step (spec §62).
 * Single transaction: verify submission is SUBMITTED (else TASK_INVALID_STATE),
 * create the official Expense (source TASK, status APPROVED immediately,
 * displayNumber EXP-…, total recomputed SERVER-side from submission items),
 * copy items with recomputed totals, post the balanced journal
 * (Dr MESS_EXPENSE / Cr CASH, refType TASK_EXPENSE), link
 * expense.sourceTaskSubmissionId (UNIQUE → duplicate money impossible),
 * flip submission→APPROVED (+expenseId) and task→APPROVED, audit twice, notify
 * the resident. Zero-total submissions approve without an expense (journal
 * lines must be non-zero — documented).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { multiplyRoundHalfUp, formatMinor } from "@/lib/money";
import { dateKeyInTz, localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { nextExpenseNumber } from "@/lib/ids";
import { postJournal, ACCOUNT_CODES } from "@/lib/domain/ledger";
import { isUniqueViolation, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { queueNotification, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const body = await parseBody(ctx.req, bodySchema);

  const result = await db.$transaction(async (tx) => {
    const submission = await tx.taskSubmission.findUnique({
      where: { id: ctx.params.id },
      include: { items: true, task: true },
    });
    if (!submission || submission.task.institutionId !== ctx.institutionId) {
      throw new ApiError(CODES.NOT_FOUND, "This submission could not be found.", 404);
    }
    if (submission.status !== "SUBMITTED") {
      throw new ApiError(CODES.TASK_INVALID_STATE, "This submission was already reviewed.", 409);
    }
    if (submission.expenseId) {
      throw new ApiError(CODES.EXPENSE_INVALID_STATE, "An expense already exists for this submission.", 409);
    }

    // Server-recomputed totals — claimedTotal is the resident's claim only.
    const lines = submission.items.map((it, idx) => ({
      itemName: it.itemName,
      quantity: it.quantity,
      unit: it.unit,
      unitPriceMinor: it.unitPriceMinor,
      lineTotalMinor: multiplyRoundHalfUp(it.quantity, it.unitPriceMinor),
      sortOrder: idx,
    }));
    const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);

    const now = new Date();
    const expenseDate = localDateMidnightUtc(dateKeyInTz(now, tz));
    const description = `Market purchase — ${submission.task.description}`;

    let expenseId: string | null = null;
    let journalId: string | null = null;
    let displayNumber: string | null = null;

    if (totalMinor > 0) {
      displayNumber = await nextExpenseNumber();
      try {
        const expense = await tx.expense.create({
          data: {
            institutionId: ctx.institutionId,
            displayNumber,
            date: expenseDate,
            status: "APPROVED",
            source: "TASK",
            description,
            comment: submission.comment ?? null,
            submittedByUserId: submission.task.assignedResidentId,
            approvedByUserId: ctx.user.id,
            reviewedAt: now,
            totalMinor,
            sourceTaskSubmissionId: submission.id, // UNIQUE — duplicate money guard
            proofFileId: submission.proofFileId ?? null,
          },
        });
        expenseId = expense.id;
        for (const line of lines) {
          await tx.expenseItem.create({
            data: {
              expenseId: expense.id,
              itemName: line.itemName,
              quantity: line.quantity,
              unit: line.unit,
              unitPriceMinor: line.unitPriceMinor,
              lineTotalMinor: line.lineTotalMinor,
              sortOrder: line.sortOrder,
            },
          });
        }
        const journal = await postJournal(
          {
            institutionId: ctx.institutionId,
            description,
            refType: "TASK_EXPENSE",
            refId: expense.id,
            createdByUserId: ctx.user.id,
            lines: [
              { accountCode: ACCOUNT_CODES.MESS_EXPENSE, debitMinor: totalMinor },
              { accountCode: ACCOUNT_CODES.CASH, creditMinor: totalMinor },
            ],
          },
          tx
        );
        journalId = journal.journalId;
        await tx.expense.update({ where: { id: expense.id }, data: { journalId } });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ApiError(
            CODES.EXPENSE_INVALID_STATE,
            "An expense already exists for this submission.",
            409
          );
        }
        throw e;
      }
    }

    await tx.taskSubmission.update({
      where: { id: submission.id },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason ?? null,
        expenseId,
      },
    });
    await tx.task.update({
      where: { id: submission.taskId },
      data: { status: "APPROVED" },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "TASK_EXPENSE_APPROVED",
        entityType: "TASK_SUBMISSION",
        entityId: submission.id,
        requestId: ctx.requestId,
        reason: body.reason ?? null,
        beforeSummary: JSON.stringify({ status: "SUBMITTED", claimedTotalMinor: submission.claimedTotalMinor }),
        afterSummary: JSON.stringify({
          status: "APPROVED",
          totalMinor,
          expenseId,
          journalId,
        }),
        metadata: {
          taskId: submission.taskId,
          residentId: submission.task.assignedResidentId,
          itemCount: lines.length,
          claimedTotalMinor: submission.claimedTotalMinor,
          approvedTotalMinor: totalMinor,
        },
      },
      tx
    );

    if (expenseId) {
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: ctx.user.id,
          actorRole: "ADMIN",
          action: "EXPENSE_CREATED",
          entityType: "EXPENSE",
          entityId: expenseId,
          requestId: ctx.requestId,
          reason: body.reason ?? null,
          afterSummary: JSON.stringify({
            displayNumber,
            status: "APPROVED",
            source: "TASK",
            totalMinor,
            journalId,
            sourceTaskSubmissionId: submission.id,
          }),
          metadata: { source: "TASK", taskId: submission.taskId, submissionId: submission.id },
        },
        tx
      );
    }

    await queueNotification(
      {
        userId: submission.task.assignedResidentId,
        institutionId: ctx.institutionId,
        type: "TASK_APPROVED",
        title: "Market purchase approved",
        message:
          totalMinor > 0
            ? `Your market purchase was approved — ${formatMinor(totalMinor)} added to expenses.`
            : "Your market purchase submission was approved.",
        entityRef: submission.taskId,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: submission.taskId,
      types: ["TASK_SUBMITTED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason: "Task purchase submission approved by admin",
      client: tx,
    });

    return {
      submissionId: submission.id,
      taskId: submission.taskId,
      status: "APPROVED",
      totalMinor,
      claimedTotalMinor: submission.claimedTotalMinor,
      expenseId,
      displayNumber,
      journalId,
      itemCount: lines.length,
    };
  });

  await sweepOutboxSafe();
  return { data: result };
});
