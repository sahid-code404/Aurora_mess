/**
 * GET & POST /api/v1/admin/formulas/variables — complete variable registry & edit handler (auth ADMIN).
 * Returns system variables, custom variables, and derived variables evaluated for the
 * requested period context (?period=YYYY-MM).
 * Allows Admin to update editable variables (guest_meal_price, deficit_threshold, grace_period_days, and custom variables).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { getInstitution } from "@/lib/institution";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import {
  FORMULA_FUNCTION_SPECS,
  FORMULA_OPERATORS,
  normalizeVariableKey,
} from "@/lib/domain/formula/variables";
import { gatherAllVariables } from "@/lib/domain/formula/registry";
import { setCustomVariableValue } from "@/lib/domain/formula/custom-variables";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const periodParam = url.searchParams.get("period");

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = periodParam
    ? (() => {
        const [y, m] = periodParam.split("-").map(Number);
        return periodBounds(y, m, tz);
      })()
    : currentPeriodBounds(tz);

  const registry = await gatherAllVariables(ctx.institutionId, bounds.year, bounds.month);

  return {
    data: {
      period: registry.period,
      variables: registry.variables,
      functions: FORMULA_FUNCTION_SPECS,
      operators: FORMULA_OPERATORS,
    },
  };
});

const updateVariableSchema = z.object({
  key: z.string().min(1, "Variable key is required"),
  value: z.number({ message: "Value is required" }),
  valueMinor: z.number().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM").optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, updateVariableSchema);
  const normalizedKey = normalizeVariableKey(body.key);

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";

  // 1. Guest Meal Price (InstitutionSettings.guestMealPriceMinor)
  if (normalizedKey === "guest_meal_price") {
    const valueMinor = body.valueMinor ?? Math.round(body.value * 100);
    if (valueMinor < 0) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Guest meal price cannot be negative", 422);
    }
    const old = await db.institutionSettings.findUnique({
      where: { institutionId: ctx.institutionId },
      select: { guestMealPriceMinor: true },
    });
    const updated = await db.institutionSettings.upsert({
      where: { institutionId: ctx.institutionId },
      update: { guestMealPriceMinor: valueMinor },
      create: { institutionId: ctx.institutionId, guestMealPriceMinor: valueMinor },
    });
    await appendAudit({
      institutionId: ctx.institutionId,
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      action: "INSTITUTION_SETTINGS_UPDATED",
      entityType: "INSTITUTION_SETTINGS",
      entityId: updated.id,
      requestId: `edit-guest-price-${Date.now()}`,
      beforeSummary: old ? `Guest meal price was ₹${(old.guestMealPriceMinor / 100).toFixed(2)}` : "Default ₹55.00",
      afterSummary: `Guest meal price updated to ₹${(valueMinor / 100).toFixed(2)}`,
      metadata: { key: "guest_meal_price", valueMinor },
    });
    return {
      data: {
        key: "guest_meal_price",
        value: valueMinor,
        valueFormatted: `₹${(valueMinor / 100).toFixed(2)}`,
        success: true,
      },
    };
  }

  // 2. Deficit Threshold (InstitutionSettings.deficitThresholdMinor)
  if (normalizedKey === "deficit_threshold") {
    const valueMinor = body.valueMinor ?? Math.round(body.value * 100);
    if (valueMinor < 0) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Deficit threshold cannot be negative", 422);
    }
    const old = await db.institutionSettings.findUnique({
      where: { institutionId: ctx.institutionId },
      select: { deficitThresholdMinor: true },
    });
    const updated = await db.institutionSettings.upsert({
      where: { institutionId: ctx.institutionId },
      update: { deficitThresholdMinor: valueMinor },
      create: { institutionId: ctx.institutionId, deficitThresholdMinor: valueMinor },
    });
    await appendAudit({
      institutionId: ctx.institutionId,
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      action: "INSTITUTION_SETTINGS_UPDATED",
      entityType: "INSTITUTION_SETTINGS",
      entityId: updated.id,
      requestId: `edit-deficit-thresh-${Date.now()}`,
      beforeSummary: old ? `Deficit threshold was ₹${(old.deficitThresholdMinor / 100).toFixed(2)}` : "Default ₹1,000.00",
      afterSummary: `Deficit threshold updated to ₹${(valueMinor / 100).toFixed(2)}`,
      metadata: { key: "deficit_threshold", valueMinor },
    });
    return {
      data: {
        key: "deficit_threshold",
        value: valueMinor,
        valueFormatted: `₹${(valueMinor / 100).toFixed(2)}`,
        success: true,
      },
    };
  }

  // 3. Grace Period Days (InstitutionSettings.gracePeriodDays)
  if (normalizedKey === "grace_period_days") {
    const days = Math.round(body.value);
    if (days < 0 || days > 365) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Grace period days must be between 0 and 365", 422);
    }
    const old = await db.institutionSettings.findUnique({
      where: { institutionId: ctx.institutionId },
      select: { gracePeriodDays: true },
    });
    const updated = await db.institutionSettings.upsert({
      where: { institutionId: ctx.institutionId },
      update: { gracePeriodDays: days },
      create: { institutionId: ctx.institutionId, gracePeriodDays: days },
    });
    await appendAudit({
      institutionId: ctx.institutionId,
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      action: "INSTITUTION_SETTINGS_UPDATED",
      entityType: "INSTITUTION_SETTINGS",
      entityId: updated.id,
      requestId: `edit-grace-days-${Date.now()}`,
      beforeSummary: old ? `Grace period was ${old.gracePeriodDays} days` : "Default 7 days",
      afterSummary: `Grace period updated to ${days} days`,
      metadata: { key: "grace_period_days", days },
    });
    return {
      data: {
        key: "grace_period_days",
        value: days,
        valueFormatted: `${days} days`,
        success: true,
      },
    };
  }

  // 4. Custom Variables (VariableDefinition category CUSTOM)
  const customDef = await db.variableDefinition.findFirst({
    where: {
      institutionId: ctx.institutionId,
      key: normalizedKey,
      category: "CUSTOM",
      archivedAt: null,
    },
  });

  if (customDef) {
    const bounds = body.period
      ? (() => {
          const [y, m] = body.period.split("-").map(Number);
          return periodBounds(y, m, tz);
        })()
      : currentPeriodBounds(tz);

    const isMoney = customDef.valueType === "MONEY";
    const numValue = isMoney ? (body.valueMinor ?? Math.round(body.value * 100)) : body.value;

    const result = await setCustomVariableValue({
      institutionId: ctx.institutionId,
      adminUserId: ctx.user.id,
      variableDefinitionId: customDef.id,
      billingPeriodKey: bounds.periodKey,
      value: numValue,
    });

    return {
      data: {
        key: customDef.key,
        value: numValue,
        period: bounds.periodKey,
        success: true,
        result,
      },
    };
  }

  // 5. Non-editable variable
  throw new ApiError(
    CODES.VALIDATION_FAILED,
    `Variable '${body.key}' is a computed system variable and cannot be manually edited.`,
    422
  );
});
