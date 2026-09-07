/**
 * POST /api/v1/admin/expenses/[id]/classification
 *
 * Reclassifies an existing DIRECT expense between MEAL_COST and EXTRA_COST.
 * This changes billing allocation semantics only; it never moves cash and never
 * rewrites the expense amount or ledger journal. Because an approved expense's
 * classification can change a live formula result, the mutation is serialized
 * with billing and is forbidden once that expense's period is frozen.
 *
 * MARKET_PURCHASE task expenses are authoritative MEAL_COST and cannot be
 * reclassified as overhead.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { getInstitution } from "@/lib/institution";
import { dateKeyInTz } from "@/lib/time";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import { assertExpensePeriodMutable } from "@/lib/domain/expense-period";
import { expenseCostClassLabel } from "@/lib/domain/expense-cost-class";
import { serializeExpense } from "@/lib/domain/serialize";

const bodySchema = z.object({
  costClass: z.enum(["MEAL_COST", "EXTRA_COST"]),
  reason: z.string().trim().min(3, "Explain why the expense classification is changing.").max(500),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const institution = await getInstitution(ctx.institutionId);
  const tz = institution?.timezone ?? "UTC";

  const changed = await db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, ctx.institutionId);

    const expense = await tx.expense.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
      include: { category: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    });
    if (!expense) {
      throw new ApiError(CODES.NOT_FOUND, "Expense not found.", 404);
    }
    if (["REJECTED", "VOIDED"].includes(expense.status)) {
      throw new ApiError(
        CODES.EXPENSE_INVALID_STATE,
        "Rejected or voided expenses are historical records and cannot be reclassified.",
        409
      );
    }
    if (expense.source === "TASK" && body.costClass !== "MEAL_COST") {
      throw new ApiError(
        CODES.EXPENSE_INVALID_STATE,
        "Market-task expenses are Meal Cost by definition and cannot be changed to Extra Cost.",
        409
      );
    }

    const currentClass = expense.costClass === "MEAL_COST" ? "MEAL_COST" : "EXTRA_COST";
    if (currentClass === body.costClass) {
      return expense;
    }

    const expenseDateKey = dateKeyInTz(expense.date, tz);
    await assertExpensePeriodMutable(tx, ctx.institutionId, expenseDateKey);

    const updated = await tx.expense.update({
      where: { id: expense.id },
      data: { costClass: body.costClass },
      include: { category: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "EXPENSE_RECLASSIFIED",
        entityType: "EXPENSE",
        entityId: expense.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({
          costClass: currentClass,
          costClassLabel: expenseCostClassLabel(currentClass),
          includedInMealCharge: currentClass === "MEAL_COST",
        }),
        afterSummary: JSON.stringify({
          costClass: body.costClass,
          costClassLabel: expenseCostClassLabel(body.costClass),
          includedInMealCharge: body.costClass === "MEAL_COST",
        }),
        metadata: {
          displayNumber: expense.displayNumber,
          status: expense.status,
          totalMinor: expense.totalMinor,
          date: expenseDateKey,
          source: expense.source,
          categoryName: expense.category?.name ?? null,
        },
        ip: ctx.req.headers.get("x-forwarded-for"),
        userAgent: ctx.req.headers.get("user-agent") ?? undefined,
      },
      tx
    );

    return updated;
  });

  return { data: serializeExpense(changed) };
});
