/**
 * GET /api/v1/admin/tasks?status=&q= — all tasks with resident names, items,
 * and submissions. Newest first, seek pagination.
 * POST /api/v1/admin/tasks — assign a market/general task (spec §60) with
 * optional estimated items; money parsed server-side; audit + resident
 * notification.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { parseDecimalToMinor } from "@/lib/money";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { listQuery, seekList } from "@/lib/domain/list";
import { queueNotification, sweepOutboxSafe } from "@/lib/domain/notify";

const statusEnum = z.enum([
  "ASSIGNED",
  "ACCEPTED",
  "REJECTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "APPROVED",
  "REJECTED_BY_ADMIN",
  "CANCELLED",
]);

const createSchema = z.object({
  taskType: z.enum(["MARKET_PURCHASE", "GENERAL"]),
  description: z.string().trim().min(3, "Describe the task.").max(500),
  assignedResidentId: z.string().min(1, "Pick a resident."),
  dueDate: dateKeySchema.optional(),
  notes: z.string().trim().max(1000).optional(),
  estimatedAmountMinor: z.string().optional(),
  items: z
    .array(
      z.object({
        itemName: z.string().trim().min(1).max(120),
        expectedQuantity: z.coerce.number().positive().optional(),
        unit: z.string().trim().max(20).optional(),
        estimatedUnitPriceMinor: z.string().optional(),
      })
    )
    .max(50)
    .default([]),
});

function serializeTask(t: Record<string, any>, resident: Record<string, any> | null) {
  return {
    id: t.id,
    taskType: t.taskType,
    description: t.description,
    assignedResidentId: t.assignedResidentId,
    assignedByUserId: t.assignedByUserId,
    residentName: resident?.profile?.fullName ?? resident?.email ?? "Resident",
    roomNumber: resident?.profile?.roomNumber ?? null,
    dueDate: t.dueDate ? keyOfUtcDate(t.dueDate) : null,
    notes: t.notes ?? null,
    estimatedAmountMinor: t.estimatedAmountMinor ?? null,
    status: t.status,
    rejectionReason: t.rejectionReason ?? null,
    adminReviewReason: t.adminReviewReason ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    items: (t.items ?? []).map((i: Record<string, any>) => ({
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
          items: (t.submission.items ?? []).map((si: Record<string, any>) => ({
            id: si.id,
            itemName: si.itemName,
            quantity: si.quantity,
            unit: si.unit,
            unitPriceMinor: si.unitPriceMinor,
            lineTotalMinor: si.lineTotalMinor,
          })),
        }
      : null,
  };
}

import { getInstitution } from "@/lib/institution";
import { periodBounds } from "@/lib/domain/formula/period-variables";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const { limit, cursor } = listQuery(ctx.req.nextUrl.searchParams);

  const statusRaw = ctx.req.nextUrl.searchParams.get("status") ?? undefined;
  const status = statusEnum.safeParse(statusRaw);
  const q = ctx.req.nextUrl.searchParams.get("q")?.trim() ?? undefined;
  const month = ctx.req.nextUrl.searchParams.get("month") ?? undefined;

  const where: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (status.success) where.status = status.data;
  if (q && q !== "") where.description = { contains: q };

  if (month) {
    const [yStr, mStr] = month.split("-");
    const inst = await getInstitution(ctx.institutionId);
    const tz = inst?.timezone ?? "Asia/Kolkata";
    const bounds = periodBounds(Number(yStr), Number(mStr), tz);
    where.createdAt = {
      gte: bounds.startInstant,
      lt: bounds.endInstant,
    };
  }

  const { items, nextCursor } = await seekList({
    client: db,
    model: "task",
    where,
    limit,
    cursor,
    include: { items: { orderBy: [{ itemName: "asc" }] }, submission: { include: { items: true } } },
  });

  const residentIds = items.map((t) => t.assignedResidentId);
  const residents = residentIds.length
    ? await db.user.findMany({ where: { id: { in: residentIds } }, include: { profile: true } })
    : [];
  const residentById = new Map(residents.map((r) => [r.id, r]));

  const data = items.map((t) => serializeTask(t, residentById.get(t.assignedResidentId) ?? null));

  const sortedData = [...data].sort((a, b) => {
    const getRank = (st: string) => {
      if (st === "SUBMITTED") return 0; // Needs admin review
      if (st === "IN_PROGRESS" || st === "ACCEPTED" || st === "ASSIGNED") return 1; // Active
      return 2; // Completed / Rejected
    };
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;

    if (rA === 1) {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const statusGroups = await db.task.groupBy({
    by: ["status"],
    where: {
      institutionId: ctx.institutionId,
      ...(where.createdAt ? { createdAt: where.createdAt } : {}),
    },
    _count: { _all: true },
  });
  const countsByStatus: Record<string, number> = {};
  for (const g of statusGroups) countsByStatus[g.status] = g._count._all;

  return { data: sortedData, meta: { cursor: nextCursor, limit, countsByStatus } };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, createSchema);

  // Estimated total (optional decimal string → Int paise).
  let estimatedAmountMinor: number | null = null;
  if (body.estimatedAmountMinor !== undefined && body.estimatedAmountMinor !== "") {
    const minor = parseDecimalToMinor(body.estimatedAmountMinor);
    if (minor == null || minor <= 0) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Please check the estimated amount.", 400, {
        estimatedAmountMinor: "Enter a valid amount like 1500.00.",
      });
    }
    estimatedAmountMinor = minor;
  }

  const itemLines: {
    itemName: string;
    expectedQuantity: number | null;
    unit: string;
    estimatedUnitPriceMinor: number | null;
  }[] = [];
  for (const [idx, item] of body.items.entries()) {
    let linePrice: number | null = null;
    if (item.estimatedUnitPriceMinor !== undefined && item.estimatedUnitPriceMinor !== "") {
      const minor = parseDecimalToMinor(item.estimatedUnitPriceMinor);
      if (minor == null || minor <= 0) {
        throw new ApiError(CODES.VALIDATION_FAILED, "Please check the estimated item prices.", 400, {
          [`items.${idx}.estimatedUnitPriceMinor`]: "Enter a valid price like 55.00.",
        });
      }
      linePrice = minor;
    }
    itemLines.push({
      itemName: item.itemName,
      expectedQuantity: item.expectedQuantity ?? null,
      unit: item.unit && item.unit !== "" ? item.unit : "unit",
      estimatedUnitPriceMinor: linePrice,
    });
  }

  const result = await db.$transaction(async (tx) => {
    const resident = await tx.user.findFirst({
      where: { id: body.assignedResidentId, institutionId: ctx.institutionId, role: "RESIDENT" },
      include: { profile: true },
    });
    if (!resident || resident.status !== "ACTIVE") {
      throw new ApiError(CODES.VALIDATION_FAILED, "Pick an active resident for this task.", 400, {
        assignedResidentId: "Pick an active resident.",
      });
    }

    const task = await tx.task.create({
      data: {
        institutionId: ctx.institutionId,
        taskType: body.taskType,
        description: body.description,
        assignedResidentId: resident.id,
        assignedByUserId: ctx.user.id,
        dueDate: body.dueDate ? localDateMidnightUtc(body.dueDate) : null,
        notes: body.notes ?? null,
        estimatedAmountMinor,
        status: "ASSIGNED",
        items: {
          create: itemLines.map((l) => ({
            itemName: l.itemName,
            expectedQuantity: l.expectedQuantity,
            unit: l.unit,
            estimatedUnitPriceMinor: l.estimatedUnitPriceMinor,
          })),
        },
      },
      include: { items: true },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "TASK_ASSIGNED",
        entityType: "TASK",
        entityId: task.id,
        requestId: ctx.requestId,
        afterSummary: JSON.stringify({
          status: "ASSIGNED",
          taskType: task.taskType,
          description: task.description,
          assignedResidentId: resident.id,
          itemCount: itemLines.length,
          estimatedAmountMinor,
        }),
        metadata: { dueDate: body.dueDate ?? null, notes: body.notes ?? null },
      },
      tx
    );

    await queueNotification(
      {
        userId: resident.id,
        institutionId: ctx.institutionId,
        type: "TASK_ASSIGNED",
        title: "Market task assigned",
        message: `New task assigned: "${task.description}"${body.dueDate ? ` — due ${body.dueDate}` : ""}.`,
        entityRef: task.id,
      },
      tx
    );

    return { task, resident };
  });

  await sweepOutboxSafe();
  return {
    data: serializeTask(
      { ...result.task, submission: null } as never,
      result.resident as never
    ),
  };
});
