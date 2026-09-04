/**
 * RESIDENT LEAVE REQUESTS (spec §35, §43, §154).
 * Leave can target ALL_MEALS or an explicit set of resident meal definitions.
 * Preview and persisted requests use the same validated selection semantics.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema, reasonSchema } from "@/lib/validation";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { dayCountBetween, ensureInstancesForRange, keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import {
  mealDefinitionIdsSchema,
  mealInstanceScopeWhere,
  mealScopeSchema,
  serializeSelectedMeals,
  validateMealScopeSelection,
} from "@/lib/domain/meal-scope";
import { listQuery, seekList } from "@/lib/domain/list";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";

const createSchema = z.object({
  startDate: dateKeySchema,
  endDate: dateKeySchema,
  reason: reasonSchema,
  mealScope: mealScopeSchema.default("ALL_MEALS"),
  mealDefinitionIds: mealDefinitionIdsSchema,
  preview: z.boolean().optional(),
});

async function previewCounts(
  institutionId: string,
  startKey: string,
  endKey: string,
  mealScope: "ALL_MEALS" | "SELECTED_MEALS",
  mealDefinitionIds: string[]
) {
  const now = new Date();
  const scopeWhere = mealInstanceScopeWhere(mealScope, mealDefinitionIds);
  const base = {
    institutionId,
    serviceDate: { gte: localDateMidnightUtc(startKey), lte: localDateMidnightUtc(endKey) },
    ...scopeWhere,
  };
  const [futureUnlockedMeals, alreadyLockedMeals] = await Promise.all([
    db.mealInstance.count({ where: { ...base, cutoffAt: { gt: now } } }),
    db.mealInstance.count({ where: { ...base, cutoffAt: { lte: now } } }),
  ]);
  return { futureUnlockedMeals, alreadyLockedMeals };
}

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const body = await parseBody(ctx.req, createSchema);

  if (body.endDate < body.startDate) {
    throw new ApiError(CODES.VALIDATION_FAILED, "The end date must be on or after the start date.", 400, {
      endDate: "End date is before the start date.",
    });
  }
  if (dayCountBetween(body.startDate, body.endDate) > 60) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Leave requests can cover at most 60 days.", 400);
  }

  const selection = await validateMealScopeSelection({
    institutionId: ctx.institutionId,
    mealScope: body.mealScope,
    mealDefinitionIds: body.mealDefinitionIds,
  });

  const previewRequested = body.preview === true || ctx.req.nextUrl.searchParams.get("preview") === "1";
  if (previewRequested) {
    await ensureInstancesForRange(ctx.institutionId, tz, body.startDate, body.endDate);
    const preview = await previewCounts(
      ctx.institutionId,
      body.startDate,
      body.endDate,
      body.mealScope,
      selection.ids
    );
    return {
      data: {
        preview: true,
        saved: false,
        startDate: body.startDate,
        endDate: body.endDate,
        dayCount: dayCountBetween(body.startDate, body.endDate),
        mealScope: body.mealScope,
        selectedMeals: selection.meals,
        ...preview,
      },
    };
  }

  const created = await db.$transaction(async (tx) => {
    // Revalidate inside the write transaction so a definition cannot become
    // archived between preview/request validation and persistence.
    const txSelection = await validateMealScopeSelection({
      institutionId: ctx.institutionId,
      mealScope: body.mealScope,
      mealDefinitionIds: selection.ids,
      client: tx,
    });

    const leave = await tx.leaveRequest.create({
      data: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        startDate: localDateMidnightUtc(body.startDate),
        endDate: localDateMidnightUtc(body.endDate),
        reason: body.reason,
        mealScope: body.mealScope,
        status: "PENDING",
        ...(txSelection.ids.length
          ? {
              selectedMeals: {
                create: txSelection.ids.map((mealDefinitionId) => ({ mealDefinitionId })),
              },
            }
          : {}),
      },
      include: {
        selectedMeals: {
          include: { mealDefinition: { select: { id: true, name: true } } },
        },
      },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "LEAVE_REQUESTED",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        requestId: ctx.requestId,
        afterSummary: JSON.stringify({
          startDate: body.startDate,
          endDate: body.endDate,
          dayCount: dayCountBetween(body.startDate, body.endDate),
          mealScope: body.mealScope,
          mealDefinitionIds: txSelection.ids,
        }),
        metadata: { reason: body.reason, mealScope: body.mealScope, mealDefinitionIds: txSelection.ids },
      },
      tx
    );

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;
    const scopeLabel =
      body.mealScope === "SELECTED_MEALS"
        ? ` for ${txSelection.meals.map((meal) => meal.name).join(", ")}`
        : "";

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "LEAVE_REQUESTED",
        title: "New leave request",
        message: `${residentName} requested leave from ${body.startDate} to ${body.endDate}${scopeLabel}.`,
        entityRef: leave.id,
      },
      tx
    );

    return leave;
  });

  await sweepOutboxSafe();

  const preview = await previewCounts(
    ctx.institutionId,
    body.startDate,
    body.endDate,
    body.mealScope,
    selection.ids
  );

  return {
    data: {
      id: created.id,
      startDate: body.startDate,
      endDate: body.endDate,
      reason: created.reason,
      status: created.status,
      ...serializeSelectedMeals(created.mealScope, created.selectedMeals),
      createdAt: created.createdAt.toISOString(),
      preview,
    },
  };
});

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const { limit, cursor } = listQuery(ctx.req.nextUrl.searchParams);

  const { items, nextCursor } = await seekList({
    client: db,
    model: "leaveRequest",
    where: { institutionId: ctx.institutionId, residentId: ctx.user.id },
    limit,
    cursor,
  });

  const leaveIds = items.map((leave) => leave.id);
  const selections = leaveIds.length
    ? await db.leaveRequestMeal.findMany({
        where: { leaveRequestId: { in: leaveIds } },
        include: { mealDefinition: { select: { id: true, name: true } } },
      })
    : [];
  const selectionsByLeave = new Map<string, typeof selections>();
  for (const selection of selections) {
    const current = selectionsByLeave.get(selection.leaveRequestId) ?? [];
    current.push(selection);
    selectionsByLeave.set(selection.leaveRequestId, current);
  }

  const now = new Date();
  const data = await Promise.all(
    items.map(async (leave) => {
      const startKey = keyOfUtcDate(leave.startDate);
      const endKey = keyOfUtcDate(leave.endDate);
      const selectedRows = selectionsByLeave.get(leave.id) ?? [];
      const selectedIds = selectedRows.map((selection) => selection.mealDefinitionId);
      const scopeWhere = mealInstanceScopeWhere(leave.mealScope, selectedIds);
      const [futureUnlockedMeals, alreadyLockedMeals] = await Promise.all([
        db.mealInstance.count({
          where: {
            institutionId: ctx.institutionId,
            serviceDate: { gte: leave.startDate, lte: leave.endDate },
            ...scopeWhere,
            cutoffAt: { gt: now },
          },
        }),
        db.mealInstance.count({
          where: {
            institutionId: ctx.institutionId,
            serviceDate: { gte: leave.startDate, lte: leave.endDate },
            ...scopeWhere,
            cutoffAt: { lte: now },
          },
        }),
      ]);
      return {
        id: leave.id,
        startDate: startKey,
        endDate: endKey,
        dayCount: dayCountBetween(startKey, endKey),
        reason: leave.reason,
        status: leave.status,
        ...serializeSelectedMeals(leave.mealScope, selectedRows),
        reviewReason: leave.reviewReason,
        reviewedAt: leave.reviewedAt ? leave.reviewedAt.toISOString() : null,
        createdAt: leave.createdAt.toISOString(),
        preview: { futureUnlockedMeals, alreadyLockedMeals },
      };
    })
  );

  return { data, meta: { cursor: nextCursor, limit } };
});
