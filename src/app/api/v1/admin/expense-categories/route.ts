/**
 * /api/v1/admin/expense-categories (auth ADMIN)
 * GET  — categories with expense counts.
 * POST — create a category {name, description?}. Per-institution unique name.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(2, "Category names need at least 2 characters.").max(60, "Keep the name under 60 characters."),
  description: z.string().trim().max(300, "Keep the description under 300 characters.").optional(),
});

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const categories = await db.expenseCategory.findMany({
    where: { institutionId: ctx.institutionId },
    orderBy: { name: "asc" },
    include: { _count: { select: { expenses: true } } },
  });
  return {
    data: categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      expenseCount: c._count.expenses,
      createdAt: c.createdAt.toISOString(),
    })),
  };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const existing = await db.expenseCategory.findFirst({
    where: { institutionId: ctx.institutionId, name: body.name },
  });
  if (existing) {
    throw new ApiError(CODES.VALIDATION_FAILED, "A category with this name already exists.", 400, {
      name: "A category with this name already exists.",
    });
  }

  const category = await db.$transaction(async (tx) => {
    const created = await tx.expenseCategory.create({
      data: {
        institutionId: ctx.institutionId,
        name: body.name,
        description: body.description ?? null,
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "EXPENSE_CATEGORY_CREATED",
        entityType: "EXPENSE_CATEGORY",
        entityId: created.id,
        requestId: ctx.requestId,
        beforeSummary: null,
        afterSummary: created.name,
        metadata: { name: created.name },
      },
      tx
    );
    return created;
  });

  return { data: { id: category.id, name: category.name, description: category.description ?? null, expenseCount: 0, createdAt: category.createdAt.toISOString() } };
});
