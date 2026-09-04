/**
 * GET /api/v1/admin/meal-definitions — list with latest version + KPIs.
 * POST /api/v1/admin/meal-definitions — create definition + immutable v1
 * MealDefinitionVersion snapshot + audit (spec §24-25). Money fields arrive as
 * decimal strings and are parsed to Int paise server-side.
 */
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext, snapshotConfig } from "@/lib/domain/meal-engine";
import {
  mealDefinitionCreateSchema,
  validateDefinitionInvariants,
} from "@/lib/domain/meal-definition-schema";

function serializeDefinition(def: Record<string, any>, latestVersion: Record<string, any> | null) {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? null,
    icon: def.icon ?? null,
    colorToken: def.colorToken ?? null,
    mealType: def.mealType,
    active: def.active,
    defaultState: def.defaultState,
    defaultVisible: def.defaultVisible,
    pricingStrategy: def.pricingStrategy,
    fixedPriceMinor: def.fixedPriceMinor ?? null,
    scheduleStrategy: def.scheduleStrategy,
    weekdaysCsv: def.weekdaysCsv ?? null,
    specificDate: def.specificDate ? new Date(def.specificDate).toISOString().slice(0, 10) : null,
    serviceStartLocal: def.serviceStartLocal,
    serviceEndLocal: def.serviceEndLocal,
    cutoffStrategy: def.cutoffStrategy,
    cutoffOffsetDays: def.cutoffOffsetDays,
    cutoffLocalTime: def.cutoffLocalTime,
    internalNotes: def.internalNotes ?? null,
    archivedAt: def.archivedAt ? new Date(def.archivedAt).toISOString() : null,
    deleteRequestedAt: def.deleteRequestedAt ? new Date(def.deleteRequestedAt).toISOString() : null,
    createdAt: new Date(def.createdAt).toISOString(),
    updatedAt: new Date(def.updatedAt).toISOString(),
    latestVersion: latestVersion
      ? { id: latestVersion.id, version: latestVersion.version, createdAt: new Date(latestVersion.createdAt).toISOString() }
      : null,
  };
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const defs = await db.mealDefinition.findMany({
    where: { institutionId: ctx.institutionId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const data = defs.map((d) => serializeDefinition(d as never, (d.versions?.[0] ?? null) as never));
  const active = data.filter((d) => d.archivedAt == null).length;
  return {
    data,
    meta: { configured: data.length, active, inactive: data.length - active },
  };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, mealDefinitionCreateSchema);

  const { fields, fixedPriceMinorParsed } = validateDefinitionInvariants(body);
  if (Object.keys(fields).length > 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the meal configuration.", 400, fields);
  }

  const duplicate = await db.mealDefinition.findFirst({
    where: { institutionId: ctx.institutionId, name: body.name },
  });
  if (duplicate) {
    throw new ApiError(CODES.VALIDATION_FAILED, "A meal with this name already exists.", 409, {
      name: "A meal with this name already exists.",
    });
  }

  const data = {
    institutionId: ctx.institutionId,
    name: body.name,
    description: body.description ?? null,
    icon: body.icon ?? null,
    colorToken: body.colorToken ?? null,
    mealType: body.mealType,
    active: true,
    defaultState: body.defaultState,
    defaultVisible: body.defaultVisible,
    pricingStrategy: body.pricingStrategy,
    fixedPriceMinor: body.pricingStrategy === "FIXED" ? fixedPriceMinorParsed : null,
    scheduleStrategy: body.scheduleStrategy,
    weekdaysCsv: body.scheduleStrategy === "WEEKDAYS" ? normalizeCsv(body.weekdaysCsv) : null,
    specificDate:
      body.scheduleStrategy === "ONE_TIME" && body.specificDate
        ? localDateMidnightUtc(body.specificDate)
        : null,
    serviceStartLocal: body.serviceStartLocal,
    serviceEndLocal: body.serviceEndLocal,
    cutoffStrategy: body.cutoffStrategy,
    cutoffOffsetDays:
      body.cutoffStrategy === "CUSTOM_OFFSET" ? (body.cutoffOffsetDays ?? 0) : body.cutoffStrategy === "PREVIOUS_DAY" ? 1 : 0,
    cutoffLocalTime: body.cutoffLocalTime,
    internalNotes: body.internalNotes ?? null,
  };

  const created = await db.$transaction(async (tx) => {
    const def = await tx.mealDefinition.create({ data });
    const version = await tx.mealDefinitionVersion.create({
      data: {
        mealDefinitionId: def.id,
        version: 1,
        configSnapshotJson: JSON.stringify(snapshotConfig({ ...data, specificDate: data.specificDate })),
        createdByUserId: ctx.user.id,
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "MEAL_DEFINITION_CREATED",
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        requestId: ctx.requestId,
        afterSummary: JSON.stringify({ name: def.name, mealType: def.mealType, version: 1 }),
        metadata: { config: snapshotConfig({ ...data, specificDate: data.specificDate }) },
      },
      tx
    );
    return { def, version };
  });

  return {
    data: serializeDefinition(
      { ...(created.def as unknown as Record<string, any>), versions: [created.version] },
      created.version as unknown as Record<string, any>
    ),
    meta: { version: created.version.version },
  };
});

function normalizeCsv(csv?: string): string | null {
  if (!csv) return null;
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[1-7]$/.test(s));
  return parts.length > 0 ? [...new Set(parts)].sort((a, b) => Number(a) - Number(b)).join(",") : null;
}
