/**
 * /api/v1/admin/expenses (auth ADMIN)
 *
 * POST — record a mess expense (spec §40-41). multipart/form-data:
 *   date (YYYY-MM-DD), categoryId?, description, comment?, proof? File,
 *   itemsJson = JSON [{itemName, quantity>0, unit?, unitPrice (decimal string)}].
 *   LINE TOTALS AND THE EXPENSE TOTAL ARE ALWAYS SERVER-COMPUTED (spec §275):
 *   lineTotal = round-half-up(quantity × unitPriceMinor); total = Σ lines.
 *   Created as PENDING with source DIRECT — approval is a separate action.
 *
 * GET — expense list with filters (status, q, month=YYYY-MM), category name,
 *   item count, proof flag. Meta: expenses this month, item entries this month,
 *   remaining funds = CASH balance from the ledger.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { formatMinor, multiplyRoundHalfUp, parseDecimalToMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { nextExpenseNumber } from "@/lib/ids";
import { dateKeySchema } from "@/lib/validation";
import { storeUpload } from "@/lib/storage";
import { sweepOutbox } from "@/lib/outbox";
import { finishPage, formFile, formText, keysetWhere, parseJsonField, readFormData } from "@/lib/domain/http";
import { serializeExpense } from "@/lib/domain/serialize";
import { getAccountBalances } from "@/lib/domain/ledger";
import { periodBounds } from "@/lib/domain/formula/period-variables";

export const dynamic = "force-dynamic";

const itemSchema = z.object({
  itemName: z.string().trim().min(1, "Item name is required.").max(90),
  quantity: z.number().positive("Quantity must be greater than zero.").max(1_000_000),
  unit: z.string().trim().max(20).optional(),
  unitPrice: z.string().min(1, "Enter a unit price."),
});

const itemsSchema = z.array(itemSchema).min(1, "Add at least one item.").max(50);

// ---------------------------------------------------------------------------
// POST — create expense
// ---------------------------------------------------------------------------
export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const form = await readFormData(ctx.req);
  const dateKeyRaw = formText(form, "date");
  const categoryId = formText(form, "categoryId");
  const description = formText(form, "description");
  const comment = formText(form, "comment");
  const proof = formFile(form, "proof");

  const fields: Record<string, string> = {};
  const dateKey = dateKeySchema.safeParse(dateKeyRaw ?? "");
  if (!dateKey.success) fields.date = "Dates use the YYYY-MM-DD format.";
  if (!description || description.length < 2 || description.length > 200) {
    fields.description = "Describe the expense in 2–200 characters.";
  }
  if (comment && comment.length > 500) fields.comment = "Keep the comment under 500 characters.";

  const rawItems = parseJsonField<unknown>(formText(form, "itemsJson"), "itemsJson");
  const parsedItems = itemsSchema.safeParse(rawItems);
  if (!parsedItems.success) {
    fields.itemsJson = parsedItems.error.issues[0]?.message ?? "The items list is not valid.";
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, fields);
  }
  const items = parsedItems.data!;

  // Server-computed money — the client never supplies totals (spec §275).
  const computed: { itemName: string; quantity: number; unit: string; unitPriceMinor: number; lineTotalMinor: number }[] = [];
  const fields2: Record<string, string> = {};
  for (const item of items) {
    const unitPriceMinor = parseDecimalToMinor(item.unitPrice);
    if (unitPriceMinor === null || unitPriceMinor < 0) {
      fields2.itemsJson = `'${item.itemName}': enter a valid unit price (up to 2 decimals).`;
      break;
    }
    const lineTotalMinor = multiplyRoundHalfUp(item.quantity, unitPriceMinor);
    computed.push({
      itemName: item.itemName,
      quantity: item.quantity,
      unit: item.unit ?? "unit",
      unitPriceMinor,
      lineTotalMinor,
    });
  }
  if (Object.keys(fields2).length > 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, fields2);
  }
  const totalMinor = computed.reduce((s, item) => s + item.lineTotalMinor, 0);
  if (totalMinor <= 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "The expense total must be greater than zero.", 400, {
      itemsJson: "Add at least one item with a price.",
    });
  }

  let category: { id: string; name: string } | null = null;
  if (categoryId) {
    const found = await db.expenseCategory.findFirst({
      where: { id: categoryId, institutionId: ctx.institutionId },
    });
    if (!found) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Choose a valid expense category.", 400, {
        categoryId: "Choose a valid expense category.",
      });
    }
    category = { id: found.id, name: found.name };
  }

  // Proof + display number are prepared BEFORE the transaction (global client;
  // a rollback leaves at most a harmless orphan file / number gap).
  const proofFile = proof ? await storeUpload(proof, ctx.institutionId, ctx.user.id) : null;
  const displayNumber = await nextExpenseNumber();
  const expenseDate = new Date(`${dateKey.data!}T00:00:00.000Z`);

  // Closed-period guard (mirrors the membership route): an expense dated inside
  // a BILLED period posts a real journal but is INVISIBLE to the immutable
  // snapshot — the cost would never be recovered from residents (audit 9-c #7).
  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const billedPeriods = await db.billingPeriod.findMany({
    where: { institutionId: ctx.institutionId, status: "BILLED" },
    select: { year: true, month: true },
  });
  for (const p of billedPeriods) {
    const bounds = periodBounds(p.year, p.month, tz);
    if (expenseDate >= bounds.startAt && expenseDate < bounds.endExclusiveAt) {
      throw new ApiError(
        CODES.BILLING_PERIOD_CLOSED,
        `The billing period for ${p.year}-${String(p.month).padStart(2, "0")} is already billed — expenses can no longer be dated inside it.`,
        409,
        { date: "This date falls inside an already-billed period." }
      );
    }
  }

  const expense = await db.$transaction(async (tx) => {
    const created = await tx.expense.create({
      data: {
        institutionId: ctx.institutionId,
        displayNumber,
        date: expenseDate,
        categoryId: category?.id ?? null,
        status: "PENDING",
        source: "DIRECT",
        description: description!,
        comment: comment ?? null,
        submittedByUserId: ctx.user.id,
        totalMinor,
        proofFileId: proofFile?.id ?? null,
      },
    });
    await tx.expenseItem.createMany({
      data: computed.map((item, index) => ({ ...item, expenseId: created.id, sortOrder: index })),
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "EXPENSE_CREATED",
        entityType: "EXPENSE",
        entityId: created.id,
        requestId: ctx.requestId,
        beforeSummary: null,
        afterSummary: "PENDING",
        metadata: {
          totalMinor,
          itemCount: computed.length,
          date: dateKey.data!,
          displayNumber,
          hasProof: Boolean(proofFile),
          categoryName: category?.name ?? null,
        },
        ip: ctx.req.headers.get("x-forwarded-for"),
        userAgent: ctx.req.headers.get("user-agent") ?? undefined,
      },
      tx
    );
    return created;
  });

  sweepOutbox(20).catch(() => {});

  const itemsRows = await db.expenseItem.findMany({
    where: { expenseId: expense.id },
    orderBy: { sortOrder: "asc" },
  });

  return {
    data: {
      ...serializeExpense({ ...expense, category }),
      items: itemsRows.map((item) => ({
        id: item.id,
        itemName: item.itemName,
        quantity: item.quantity,
        unit: item.unit,
        unitPriceMinor: item.unitPriceMinor,
        unitPriceFormatted: formatMinor(item.unitPriceMinor),
        lineTotalMinor: item.lineTotalMinor,
        lineTotalFormatted: formatMinor(item.lineTotalMinor),
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// GET — list expenses
// ---------------------------------------------------------------------------
export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = (url.searchParams.get("q") ?? "").trim();
  const month = url.searchParams.get("month") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  const fields: Record<string, string> = {};
  if (status && !["DRAFT", "PENDING", "APPROVED", "REJECTED", "VOIDED"].includes(status)) {
    fields.status = "Unknown expense status filter.";
  }
  let monthYear: { year: number; month: number } | null = null;
  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      fields.month = "Months use the YYYY-MM format.";
    } else {
      monthYear = { year: Number(m[1]), month: Number(m[2]) };
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the filters.", 400, fields);
  }

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";

  const base: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (status) base.status = status;
  if (monthYear) {
    const bounds = periodBounds(monthYear.year, monthYear.month, tz);
    base.date = { gte: bounds.startAt, lt: bounds.endExclusiveAt };
  }
  let searchConditions: Record<string, unknown>[] | null = null;
  if (q) {
    searchConditions = [{ displayNumber: { contains: q } }, { description: { contains: q } }];
  }

  const { where, take } = keysetWhere(base, "createdAt", cursor, limit);
  if (searchConditions) {
    where.AND = [...((where.AND as Record<string, unknown>[]) ?? []), { OR: searchConditions }];
  }
  const rows = await db.expense.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    include: { category: { select: { id: true, name: true } }, _count: { select: { items: true } } },
  });
  const page = finishPage(rows, limit, (row) => row.createdAt);

  const now = new Date();
  const currentYear = monthYear?.year ?? Number(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(now));
  const currentMonth = monthYear?.month ?? Number(new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit" }).format(now));
  const bounds = periodBounds(currentYear, currentMonth, tz);
  const [expensesAgg, entriesThisMonth, accounts, pendingApprovalCount] = await Promise.all([
    db.expense.aggregate({
      _sum: { totalMinor: true },
      where: { institutionId: ctx.institutionId, status: "APPROVED", date: { gte: bounds.startAt, lt: bounds.endExclusiveAt } },
    }),
    db.expenseItem.count({
      where: {
        expense: {
          institutionId: ctx.institutionId,
          date: { gte: bounds.startAt, lt: bounds.endExclusiveAt },
        },
      },
    }),
    getAccountBalances(ctx.institutionId),
    db.expense.count({
      where: { institutionId: ctx.institutionId, status: "PENDING" },
    }),
  ]);
  const cash = accounts.find((a) => a.code === "CASH");

  const sortedItems = [...page.items].sort((a, b) => {
    const pA = a.status === "PENDING" ? 0 : 1;
    const pB = b.status === "PENDING" ? 0 : 1;
    if (pA !== pB) return pA - pB;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return {
    data: sortedItems.map((e) => serializeExpense(e)),
    meta: {
      nextCursor: page.nextCursor,
      month: `${currentYear}-${String(currentMonth).padStart(2, "0")}`,
      expensesThisMonth: expensesAgg._sum.totalMinor ?? 0,
      expensesThisMonthFormatted: formatMinor(expensesAgg._sum.totalMinor ?? 0),
      entriesThisMonth: entriesThisMonth,
      pendingApproval: pendingApprovalCount,
      remainingFunds: cash?.balanceMinor ?? 0,
      remainingFundsFormatted: formatMinor(cash?.balanceMinor ?? 0),
    },
  };
});
