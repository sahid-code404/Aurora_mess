/**
 * POST /api/v1/admin/calendar — create a calendar event (spec §44, §147).
 * Meal disabling may apply to ALL_MEALS or explicitly SELECTED_MEALS.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { dayCountBetween, keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import {
  mealDefinitionIdsSchema,
  mealScopeSchema,
  serializeSelectedMeals,
  validateMealScopeSelection,
} from "@/lib/domain/meal-scope";

const bodySchema = z.object({
  name: z.string().trim().min(2, "Give the event a name.").max(90),
  description: z.string().trim().max(500).optional(),
  startDate: dateKeySchema,
  endDate: dateKeySchema,
  type: z.enum(["HOLIDAY", "FESTIVAL", "MAINTENANCE", "CUSTOM"]),
  disableMeals: z.boolean().default(false),
  mealScope: mealScopeSchema.default("ALL_MEALS"),
  mealDefinitionIds: mealDefinitionIdsSchema,
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);

  if (body.endDate < body.startDate) {
    throw new ApiError(CODES.VALIDATION_FAILED, "The end date must be on or after the start date.", 400, {
      endDate: "End date is before the start date.",
    });
  }
  if (dayCountBetween(body.startDate, body.endDate) > 366) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Events can span at most 366 days.", 400);
  }
  if (!body.disableMeals && (body.mealScope !== "ALL_MEALS" || (body.mealDefinitionIds?.length ?? 0) > 0)) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "Meal scope can only be selected when this event disables meals.",
      422
    );
  }

  const selection = await validateMealScopeSelection({
    institutionId: ctx.institutionId,
    mealScope: body.disableMeals ? body.mealScope : "ALL_MEALS",
    mealDefinitionIds: body.disableMeals ? body.mealDefinitionIds : undefined,
  });

  const created = await db.$transaction(async (tx) => {
    const txSelection = await validateMealScopeSelection({
      institutionId: ctx.institutionId,
      mealScope: body.disableMeals ? body.mealScope : "ALL_MEALS",
      mealDefinitionIds: selection.ids,
      client: tx,
    });

    const event = await tx.calendarEvent.create({
      data: {
        institutionId: ctx.institutionId,
        name: body.name,
        description: body.description ?? null,
        startDate: localDateMidnightUtc(body.startDate),
        endDate: localDateMidnightUtc(body.endDate),
        type: body.type,
        disableMeals: body.disableMeals,
        mealScope: body.disableMeals ? body.mealScope : "ALL_MEALS",
        createdByUserId: ctx.user.id,
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
        actorRole: "ADMIN",
        action: "CALENDAR_EVENT_CREATED",
        entityType: "CALENDAR_EVENT",
        entityId: event.id,
        requestId: ctx.requestId,
        afterSummary: JSON.stringify({
          name: body.name,
          type: body.type,
          startDate: body.startDate,
          endDate: body.endDate,
          disableMeals: body.disableMeals,
          mealScope: event.mealScope,
          mealDefinitionIds: txSelection.ids,
        }),
      },
      tx
    );
    return event;
  });

  return {
    data: {
      id: created.id,
      name: created.name,
      description: created.description,
      startDate: keyOfUtcDate(created.startDate),
      endDate: keyOfUtcDate(created.endDate),
      type: created.type,
      disableMeals: created.disableMeals,
      ...serializeSelectedMeals(created.mealScope, created.selectedMeals),
      createdAt: created.createdAt.toISOString(),
    },
  };
});
