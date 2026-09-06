/**
 * GET /api/v1/admin/meal-definitions/[id] — definition + full version history.
 * PUT /api/v1/admin/meal-definitions/[id] — update fields and create a NEW
 * immutable MealDefinitionVersion (version+1, snapshot). Old snapshots are
 * NEVER mutated; already-materialized instances keep pointing at their own
 * version (spec §24-25). Audit MEAL_DEFINITION_UPDATED with before/after.
 */
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import {
  keyOfUtcDate,
  requireInstitutionContext,
  snapshotConfig,
} from "@/lib/domain/meal-engine";
import {
  mealDefinitionUpdateSchema,
  validateDefinitionInvariants,
} from "@/lib/domain/meal-definition-schema";
import {
  lockMealDefinitionMutation,
  refreshDueMealDefinitionRetirements,
} from "@/lib/domain/meal-retirement";

function serializeVersion(v: Record<string, any>) {
  return {
    id: v.id,
    version: v.version,
    configSnapshot: (() => {
      try {
        return JSON.parse(v.configSnapshotJson);
      } catch {
        return null;
      }
    })(),
    createdByUserId: v.creatededByUserId ?? null,
    createdAt: new Date(v.createdAt).toISOString(),
  };
}

function serializeDefinition(def: Record<string, any>) {
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
    specificDate: def.specificDate ? keyOfUtcDate(new Date(def.specificDate)) : null,
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
  };
}

function normalizeCsv(csv: string | undefined, prev: string | null): string | null {
  const source = csv !== undefined ? csv : (prev ?? undefined);
  if (!source) return null;
  const parts = source
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[1-7]$/.test(s));
  return parts.length > 0 ? [...new Set(parts)].sort((a, b) => Number(a) - Number(b)).join(",") : null;
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  await refreshDueMealDefinitionRetirements(ctx.institutionId);
  const def = await db.mealDefinition.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
  const latestDeletion = await db.deletionRequest.findFirst({
    where: {
      institutionId: ctx.institutionId,
      entityType: "MEAL_DEFINITION",
      entityId: def.id,
    },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
  });
  if (latestDeletion?.status === "COMPLETED") {
    throw new ApiError(CODES.NOT_FOUND, "This meal definition has completed its deletion lifecycle.", 404);
  }
  return {
    data: {
      ...serializeDefinition(def as never),
      deletionRequest: latestDeletion
        ? {
            id: latestDeletion.id,
            status: latestDeletion.status,
            requestedAt: latestDeletion.requestedAt.toISOString(),
            scheduledFor: latestDeletion.scheduledFor?.toISOString() ?? null,
            reason: latestDeletion.reason,
            blockedReason: latestDeletion.blockedReason,
            completedAt: latestDeletion.completedAt?.toISOString() ?? null,
            cancelReason: latestDeletion.cancelReason,
            cancelledByUserId: latestDeletion.cancelledByUserId,
            cancelledAt: latestDeletion.cancelledAt?.toISOString() ?? null,
          }
        : null,
      versions: ((def.versions ?? []) as Record<string, any>[]).map(serializeVersion),
    },
  };
});

export const PUT = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  await refreshDueMealDefinitionRetirements(ctx.institutionId);
  const patch = await parseBody(ctx.req, mealDefinitionUpdateSchema);

  const result = await db.$transaction(async (tx) => {
    await lockMealDefinitionMutation(tx, ctx.institutionId, ctx.params.id);
    const def = await tx.mealDefinition.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
    const deletionRequest = await tx.deletionRequest.findFirst({
      where: {
        institutionId: ctx.institutionId,
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        status: { in: ["QUEUED", "SCHEDULED", "BLOCKED", "COMPLETED"] },
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    });
    if (def.deleteRequestedAt || deletionRequest) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        deletionRequest?.status === "COMPLETED"
          ? "A completed deletion tombstone cannot be edited."
          : "Cancel the deletion request before editing this meal definition.",
        409
      );
    }

    // Merge patch onto the current config and validate the RESULT as a whole.
    const merged = {
      name: patch.name !== undefined ? patch.name : def.name,
      description: patch.description !== undefined ? (patch.description ?? null) : def.description,
      icon: patch.icon !== undefined ? (patch.icon ?? null) : def.icon,
      colorToken: patch.colorToken !== undefined ? (patch.colorToken ?? null) : def.colorToken,
      mealType: patch.mealType !== undefined ? patch.mealType : def.mealType,
      defaultState: patch.defaultState !== undefined ? patch.defaultState : def.defaultState,
      defaultVisible: patch.defaultVisible !== undefined ? patch.defaultVisible : def.defaultVisible,
      pricingStrategy: patch.pricingStrategy !== undefined ? patch.pricingStrategy : def.pricingStrategy,
      fixedPriceMinor:
        patch.fixedPriceMinor !== undefined ? patch.fixedPriceMinor : def.fixedPriceMinor != null ? String(def.fixedPriceMinor / 100) : undefined,
      scheduleStrategy: patch.scheduleStrategy !== undefined ? patch.scheduleStrategy : def.scheduleStrategy,
      weekdaysCsv: normalizeCsv(patch.weekdaysCsv, def.weekdaysCsv),
      specificDate:
        patch.specificDate !== undefined ? patch.specificDate : def.specificDate ? keyOfUtcDate(new Date(def.specificDate)) : null,
      serviceStartLocal: patch.serviceStartLocal !== undefined ? patch.serviceStartLocal : def.serviceStartLocal,
      serviceEndLocal: patch.serviceEndLocal !== undefined ? patch.serviceEndLocal : def.serviceEndLocal,
      cutoffStrategy: patch.cutoffStrategy !== undefined ? patch.cutoffStrategy : def.cutoffStrategy,
      cutoffOffsetDays:
        patch.cutoffOffsetDays !== undefined ? patch.cutoffOffsetDays : def.cutoffOffsetDays,
      cutoffLocalTime: patch.cutoffLocalTime !== undefined ? patch.cutoffLocalTime : def.cutoffLocalTime,
      internalNotes: patch.internalNotes !== undefined ? (patch.internalNotes ?? null) : def.internalNotes,
    };

    const { fields, fixedPriceMinorParsed } = validateDefinitionInvariants(merged);
    if (Object.keys(fields).length > 0) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Please check the meal configuration.", 400, fields);
    }

    if (patch.name !== undefined && patch.name !== def.name) {
      const duplicate = await tx.mealDefinition.findFirst({
        where: { institutionId: ctx.institutionId, name: patch.name, id: { not: def.id } },
      });
      if (duplicate) {
        throw new ApiError(CODES.VALIDATION_FAILED, "A meal with this name already exists.", 409, {
          name: "A meal with this name already exists.",
        });
      }
    }

    const data = {
      name: merged.name,
      description: merged.description ?? null,
      icon: merged.icon ?? null,
      colorToken: merged.colorToken ?? null,
      mealType: merged.mealType,
      defaultState: merged.defaultState,
      defaultVisible: merged.defaultVisible,
      pricingStrategy: merged.pricingStrategy,
      fixedPriceMinor: merged.pricingStrategy === "FIXED" ? fixedPriceMinorParsed : null,
      scheduleStrategy: merged.scheduleStrategy,
      weekdaysCsv: merged.scheduleStrategy === "WEEKDAYS" ? merged.weekdaysCsv : null,
      specificDate: merged.scheduleStrategy === "ONE_TIME" && merged.specificDate ? localDateMidnightUtc(merged.specificDate) : null,
      serviceStartLocal: merged.serviceStartLocal,
      serviceEndLocal: merged.serviceEndLocal,
      cutoffStrategy: merged.cutoffStrategy,
      cutoffOffsetDays: merged.cutoffStrategy === "CUSTOM_OFFSET" ? (merged.cutoffOffsetDays ?? 0) : merged.cutoffStrategy === "PREVIOUS_DAY" ? 1 : 0,
      cutoffLocalTime: merged.cutoffLocalTime,
      internalNotes: merged.internalNotes ?? null,
    };

    const updated = await tx.mealDefinition.update({ where: { id: def.id }, data });
    const nextVersionNo = (def.versions?.[0]?.version ?? 0) + 1;
    const version = await tx.mealDefinitionVersion.create({
      data: {
        mealDefinitionId: def.id,
        version: nextVersionNo,
        configSnapshotJson: JSON.stringify(snapshotConfig({ ...data, specificDate: data.specificDate })),
        createdByUserId: ctx.user.id,
      },
    });

    const beforeSnapshot = snapshotConfig(def as never);
    const afterSnapshot = snapshotConfig({ ...data, specificDate: data.specificDate });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "MEAL_DEFINITION_UPDATED",
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify(beforeSnapshot),
        afterSummary: JSON.stringify(afterSnapshot),
        metadata: { newVersion: nextVersionNo },
      },
      tx
    );

    return { updated, version, nextVersionNo };
  });

  return {
    data: {
      ...serializeDefinition(result.updated as never),
      latestVersion: { id: result.version.id, version: result.nextVersionNo },
    },
    meta: { version: result.nextVersionNo },
  };
});
