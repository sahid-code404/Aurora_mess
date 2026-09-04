/**
 * POST /api/v1/admin/formulas/custom-variables — create custom variable (auth ADMIN).
 * GET /api/v1/admin/formulas/custom-variables — list custom variables with history.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { createCustomVariable } from "@/lib/domain/formula/custom-variables";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  key: z.string().max(64).optional(),
  description: z.string().max(500).optional(),
  valueType: z.enum(["MONEY", "NUMBER", "PERCENTAGE", "COUNT", "DURATION", "BOOLEAN"]).default("MONEY"),
  unit: z.enum(["INR", "PERCENT", "MEALS", "RESIDENTS", "DAYS", "HOURS", "NONE"]).default("INR"),
  scope: z.enum(["GLOBAL", "BILLING_PERIOD", "RESIDENT", "MEAL", "DATE"]).default("BILLING_PERIOD"),
  frequency: z.enum(["CONSTANT", "MONTHLY", "ONE_TIME"]).default("MONTHLY"),
  initialValue: z.number(),
  effectivePeriod: z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM").optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, createSchema);
  const result = await createCustomVariable({
    institutionId: ctx.institutionId,
    adminUserId: ctx.user.id,
    name: body.name,
    key: body.key,
    description: body.description,
    valueType: body.valueType,
    unit: body.unit,
    scope: body.scope,
    frequency: body.frequency,
    initialValue: body.initialValue,
    effectivePeriod: body.effectivePeriod,
  });
  return { data: result };
});

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const items = await db.variableDefinition.findMany({
    where: { institutionId: ctx.institutionId, category: "CUSTOM", archivedAt: null },
    include: {
      customValues: {
        orderBy: { effectiveFrom: "desc" },
      },
    },
    orderBy: { displayName: "asc" },
  });

  return {
    data: items.map((item) => ({
      id: item.id,
      key: item.key,
      displayName: item.displayName,
      description: item.description,
      valueType: item.valueType,
      unit: item.unit,
      scope: item.scope,
      frequency: item.frequency,
      isPinned: item.isPinned,
      history: item.customValues.map((v) => ({
        id: v.id,
        billingPeriodKey: v.billingPeriodKey,
        effectiveFrom: v.effectiveFrom.toISOString(),
        effectiveUntil: v.effectiveUntil?.toISOString() ?? null,
        valueMinor: v.valueMinor,
        valueNumber: v.valueNumber,
        valueBoolean: v.valueBoolean,
        createdAt: v.createdAt.toISOString(),
      })),
    })),
  };
});
