/**
 * RESIDENT LEAVE REQUESTS (spec §35, §154).
 * POST creates a PENDING request; supports PREVIEW mode (body.preview=true or
 * ?preview=1) which materializes + counts affected meals WITHOUT saving —
 * preview-before-submit (spec §154).
 * GET returns own requests (newest first, seek pagination) each with a preview
 * of affected meals counted from existing instances: unlocked = cutoffAt > now,
 * locked = cutoffAt <= now.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema, reasonSchema } from "@/lib/validation";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { dayCountBetween, ensureInstancesForRange, keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { listQuery, seekList } from "@/lib/domain/list";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";

const createSchema = z.object({
  startDate: dateKeySchema,
  endDate: dateKeySchema,
  reason: reasonSchema,
  mealScope: z.literal("ALL_MEALS").optional(), // v1: all meals (documented)
  preview: z.boolean().optional(),
});

/** Count existing instances in the leave window split by cutoff state. */
async function previewCounts(institutionId: string, startKey: string, endKey: string) {
  const now = new Date();
  const [futureUnlockedMeals, alreadyLockedMeals] = await Promise.all([
    db.mealInstance.count({
      where: {
        institutionId,
        serviceDate: { gte: localDateMidnightUtc(startKey), lte: localDateMidnightUtc(endKey) },
        cutoffAt: { gt: now },
      },
    }),
    db.mealInstance.count({
      where: {
        institutionId,
        serviceDate: { gte: localDateMidnightUtc(startKey), lte: localDateMidnightUtc(endKey) },
        cutoffAt: { lte: now },
      },
    }),
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

  // PREVIEW MODE (spec §154): materialize + count, never save.
  const previewRequested = body.preview === true || ctx.req.nextUrl.searchParams.get("preview") === "1";
  if (previewRequested) {
    await ensureInstancesForRange(ctx.institutionId, tz, body.startDate, body.endDate);
    const preview = await previewCounts(ctx.institutionId, body.startDate, body.endDate);
    return {
      data: {
        preview: true,
        saved: false,
        startDate: body.startDate,
        endDate: body.endDate,
        dayCount: dayCountBetween(body.startDate, body.endDate),
        ...preview,
      },
    };
  }

  const created = await db.$transaction(async (tx) => {
    const leave = await tx.leaveRequest.create({
      data: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        startDate: localDateMidnightUtc(body.startDate),
        endDate: localDateMidnightUtc(body.endDate),
        reason: body.reason,
        status: "PENDING",
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
        afterSummary: JSON.stringify({ startDate: body.startDate, endDate: body.endDate, dayCount: dayCountBetween(body.startDate, body.endDate) }),
        metadata: { reason: body.reason, mealScope: body.mealScope ?? "ALL_MEALS" },
      },
      tx
    );

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "LEAVE_REQUESTED",
        title: "New leave request",
        message: `${residentName} requested leave from ${body.startDate} to ${body.endDate}.`,
        entityRef: leave.id,
      },
      tx
    );

    return leave;
  });

  await sweepOutboxSafe();

  const preview = await previewCounts(ctx.institutionId, body.startDate, body.endDate);

  return {
    data: {
      id: created.id,
      startDate: body.startDate,
      endDate: body.endDate,
      reason: created.reason,
      status: created.status,
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

  const now = new Date();
  const data = await Promise.all(
    items.map(async (leave) => {
      const startKey = keyOfUtcDate(leave.startDate);
      const endKey = keyOfUtcDate(leave.endDate);
      const [futureUnlockedMeals, alreadyLockedMeals] = await Promise.all([
        db.mealInstance.count({
          where: {
            institutionId: ctx.institutionId,
            serviceDate: { gte: leave.startDate, lte: leave.endDate },
            cutoffAt: { gt: now },
          },
        }),
        db.mealInstance.count({
          where: {
            institutionId: ctx.institutionId,
            serviceDate: { gte: leave.startDate, lte: leave.endDate },
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
        reviewReason: leave.reviewReason,
        reviewedAt: leave.reviewedAt ? leave.reviewedAt.toISOString() : null,
        createdAt: leave.createdAt.toISOString(),
        preview: { futureUnlockedMeals, alreadyLockedMeals },
      };
    })
  );

  return { data, meta: { cursor: nextCursor, limit } };
});
