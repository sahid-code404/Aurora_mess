from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}\n--- OLD ---\n{old[:500]}")
    p.write_text(text.replace(old, new, 1))


def write(path: str, content: str) -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


# ---------------------------------------------------------------------------
# Prisma lifecycle provenance + due-sweep index/backfill migration.
# ---------------------------------------------------------------------------
replace_once(
    "prisma/schema.prisma",
    '''model DeletionRequest {
  id                String    @id @default(cuid())
  institutionId     String
  entityType        String // MEAL_DEFINITION | USER | ...
  entityId          String
  requestedByUserId String
  requestedAt       DateTime  @default(now())
  scheduledFor      DateTime?
  reason            String?
  status            String    @default("QUEUED") // QUEUED | SCHEDULED | BLOCKED | COMPLETED | CANCELLED
  blockedReason     String?
  completedAt       DateTime?
}''',
    '''model DeletionRequest {
  id                String    @id @default(cuid())
  institutionId     String
  entityType        String // MEAL_DEFINITION | USER | ...
  entityId          String
  requestedByUserId String
  requestedAt       DateTime  @default(now())
  scheduledFor      DateTime?
  reason            String?
  status            String    @default("QUEUED") // QUEUED | SCHEDULED | BLOCKED | COMPLETED | CANCELLED
  blockedReason     String?
  completedAt       DateTime?
  cancelReason      String?
  cancelledByUserId String?
  cancelledAt       DateTime?

  @@index([institutionId, entityType, status, scheduledFor])
}'''
)

write(
    "prisma/migrations/20260906_080000_meal_definition_retirement_lifecycle/migration.sql",
    '''-- Phase 46 — Meal-definition retirement lifecycle.
-- Cancellation provenance is persisted on the request itself; audit remains
-- append-only context, not the only source of lifecycle truth.
ALTER TABLE "DeletionRequest"
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3);

CREATE INDEX "DeletionRequest_institutionId_entityType_status_scheduledFor_idx"
  ON "DeletionRequest"("institutionId", "entityType", "status", "scheduledFor");

-- Historical meal deletion requests were created as QUEUED even though they
-- already had a concrete scheduledFor timestamp. Normalize them to the real
-- persisted state and immediately enforce the promised generation stop.
UPDATE "DeletionRequest"
SET "status" = 'SCHEDULED'
WHERE "entityType" = 'MEAL_DEFINITION'
  AND "status" = 'QUEUED'
  AND "scheduledFor" IS NOT NULL;

UPDATE "MealDefinition" AS md
SET
  "archivedAt" = COALESCE(md."archivedAt", md."deleteRequestedAt", NOW()),
  "active" = FALSE
WHERE md."deleteRequestedAt" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "DeletionRequest" AS dr
    WHERE dr."institutionId" = md."institutionId"
      AND dr."entityType" = 'MEAL_DEFINITION'
      AND dr."entityId" = md."id"
      AND dr."status" IN ('QUEUED', 'SCHEDULED', 'BLOCKED')
  );
'''
)

# ---------------------------------------------------------------------------
# Domain state machine.
# ---------------------------------------------------------------------------
write(
    "src/lib/domain/meal-retirement.ts",
    '''import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";

const ENTITY_TYPE = "MEAL_DEFINITION";
const DAY_MS = 86_400_000;
const ACTIVE_REQUEST_STATES = ["QUEUED", "SCHEDULED", "BLOCKED"];
const DUE_REQUEST_STATES = ["QUEUED", "SCHEDULED"];

type Client = any;

type ActorInput = {
  institutionId: string;
  mealDefinitionId: string;
  actorUserId: string;
  requestId: string;
  now?: Date;
};

async function inTransaction<T>(client: Client, fn: (tx: Client) => Promise<T>): Promise<T> {
  if (typeof client?.$transaction === "function") return client.$transaction(fn);
  return fn(client);
}

export async function scheduleMealDefinitionDeletion(
  input: ActorInput & { reason: string },
  client: Client = db
) {
  const now = input.now ?? new Date();
  return inTransaction(client, async (tx) => {
    const definition = await tx.mealDefinition.findFirst({
      where: { id: input.mealDefinitionId, institutionId: input.institutionId },
    });
    if (!definition) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);

    const activeRequest = await tx.deletionRequest.findFirst({
      where: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        status: { in: ACTIVE_REQUEST_STATES },
      },
      orderBy: { requestedAt: "desc" },
    });
    if (activeRequest || definition.deleteRequestedAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "A deletion request already exists for this meal definition.", 409);
    }

    const scheduledFor = new Date(now.getTime() + 30 * DAY_MS);
    const request = await tx.deletionRequest.create({
      data: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        requestedByUserId: input.actorUserId,
        requestedAt: now,
        scheduledFor,
        reason: input.reason,
        status: "SCHEDULED",
      },
    });
    const updated = await tx.mealDefinition.update({
      where: { id: definition.id },
      data: {
        active: false,
        archivedAt: definition.archivedAt ?? now,
        deleteRequestedAt: now,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "MEAL_DELETION_SCHEDULED",
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: JSON.stringify({ active: definition.active, archivedAt: definition.archivedAt }),
        afterSummary: JSON.stringify({
          active: false,
          archivedAt: updated.archivedAt?.toISOString() ?? null,
          deletionRequestId: request.id,
          status: request.status,
          scheduledFor: scheduledFor.toISOString(),
        }),
        metadata: { deletionRequestId: request.id, scheduledFor: scheduledFor.toISOString() },
      },
      tx
    );

    return { request, definition: updated };
  });
}

export async function cancelMealDefinitionDeletion(
  input: ActorInput & { reason: string },
  client: Client = db
) {
  const now = input.now ?? new Date();
  return inTransaction(client, async (tx) => {
    const definition = await tx.mealDefinition.findFirst({
      where: { id: input.mealDefinitionId, institutionId: input.institutionId },
    });
    if (!definition) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);

    const request = await tx.deletionRequest.findFirst({
      where: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        status: { in: ACTIVE_REQUEST_STATES },
      },
      orderBy: { requestedAt: "desc" },
    });
    if (!request) {
      throw new ApiError(CODES.VALIDATION_FAILED, "There is no active deletion request to cancel.", 409);
    }

    const guard = await tx.deletionRequest.updateMany({
      where: { id: request.id, status: { in: ACTIVE_REQUEST_STATES } },
      data: {
        status: "CANCELLED",
        cancelReason: input.reason,
        cancelledByUserId: input.actorUserId,
        cancelledAt: now,
      },
    });
    if (guard.count !== 1) {
      throw new ApiError(CODES.RESOURCE_CHANGED, "This deletion request was already changed.", 409);
    }

    const updated = await tx.mealDefinition.update({
      where: { id: definition.id },
      data: { deleteRequestedAt: null },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "MEAL_DELETION_CANCELLED",
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: JSON.stringify({ deletionRequestId: request.id, status: request.status }),
        afterSummary: JSON.stringify({ deletionRequestId: request.id, status: "CANCELLED" }),
        metadata: {
          deletionRequestId: request.id,
          remainsArchived: updated.archivedAt != null,
        },
      },
      tx
    );

    return {
      request: await tx.deletionRequest.findUniqueOrThrow({ where: { id: request.id } }),
      definition: updated,
    };
  });
}

export async function restoreMealDefinition(input: ActorInput, client: Client = db) {
  const now = input.now ?? new Date();
  return inTransaction(client, async (tx) => {
    const definition = await tx.mealDefinition.findFirst({
      where: { id: input.mealDefinitionId, institutionId: input.institutionId },
    });
    if (!definition) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
    if (!definition.archivedAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This meal definition is already active.", 409);
    }

    const activeRequest = await tx.deletionRequest.findFirst({
      where: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        status: { in: ACTIVE_REQUEST_STATES },
      },
      orderBy: { requestedAt: "desc" },
    });
    if (definition.deleteRequestedAt || activeRequest) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Cancel the deletion request before restoring this meal definition.",
        409
      );
    }

    const completedRequest = await tx.deletionRequest.findFirst({
      where: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        status: "COMPLETED",
      },
      orderBy: { completedAt: "desc" },
    });
    if (completedRequest) {
      throw new ApiError(CODES.VALIDATION_FAILED, "A completed deletion tombstone cannot be restored.", 409);
    }

    const updated = await tx.mealDefinition.update({
      where: { id: definition.id },
      data: { active: true, archivedAt: null },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "MEAL_DEFINITION_RESTORED",
        entityType: ENTITY_TYPE,
        entityId: definition.id,
        requestId: input.requestId,
        beforeSummary: JSON.stringify({ active: false, archivedAt: definition.archivedAt.toISOString() }),
        afterSummary: JSON.stringify({ active: true, archivedAt: null, restoredAt: now.toISOString() }),
      },
      tx
    );

    return updated;
  });
}

/**
 * Lazily advances due meal deletion requests. Meal materialization is already
 * lazy in BoardOps, so this is invoked before materializing and before Admin
 * configuration reads. Scheduling archives immediately; therefore a quiet
 * system cannot generate new services while waiting for this terminal sweep.
 */
export async function refreshDueMealDefinitionRetirements(
  institutionId: string,
  client: Client = db,
  now: Date = new Date()
): Promise<{ completed: number; blocked: number }> {
  const due = await client.deletionRequest.findMany({
    where: {
      institutionId,
      entityType: ENTITY_TYPE,
      status: { in: DUE_REQUEST_STATES },
      scheduledFor: { lte: now },
    },
    orderBy: [{ scheduledFor: "asc" }, { requestedAt: "asc" }],
    take: 100,
  });

  let completed = 0;
  let blocked = 0;
  for (const candidate of due) {
    await inTransaction(client, async (tx) => {
      const request = await tx.deletionRequest.findFirst({
        where: {
          id: candidate.id,
          institutionId,
          entityType: ENTITY_TYPE,
          status: { in: DUE_REQUEST_STATES },
          scheduledFor: { lte: now },
        },
      });
      if (!request) return;

      const definition = await tx.mealDefinition.findFirst({
        where: { id: request.entityId, institutionId },
      });
      if (!definition) {
        const guard = await tx.deletionRequest.updateMany({
          where: { id: request.id, status: { in: DUE_REQUEST_STATES } },
          data: {
            status: "BLOCKED",
            blockedReason: "The referenced meal definition no longer exists; manual reconciliation is required.",
            completedAt: null,
          },
        });
        if (guard.count === 1) {
          blocked += 1;
          await appendAudit(
            {
              institutionId,
              actorUserId: null,
              actorRole: "SYSTEM",
              action: "MEAL_DELETION_BLOCKED",
              entityType: ENTITY_TYPE,
              entityId: request.entityId,
              reason: "Referenced meal definition missing during retirement sweep.",
              afterSummary: JSON.stringify({ deletionRequestId: request.id, status: "BLOCKED" }),
              metadata: { deletionRequestId: request.id },
            },
            tx
          );
        }
        return;
      }

      const guard = await tx.deletionRequest.updateMany({
        where: { id: request.id, status: { in: DUE_REQUEST_STATES } },
        data: { status: "COMPLETED", completedAt: now, blockedReason: null },
      });
      if (guard.count !== 1) return;

      await tx.mealDefinition.update({
        where: { id: definition.id },
        data: {
          active: false,
          archivedAt: definition.archivedAt ?? request.requestedAt,
          deleteRequestedAt: definition.deleteRequestedAt ?? request.requestedAt,
        },
      });

      completed += 1;
      await appendAudit(
        {
          institutionId,
          actorUserId: null,
          actorRole: "SYSTEM",
          action: "MEAL_DELETION_COMPLETED",
          entityType: ENTITY_TYPE,
          entityId: definition.id,
          reason: "30-day deletion safety window elapsed.",
          beforeSummary: JSON.stringify({ deletionRequestId: request.id, status: request.status }),
          afterSummary: JSON.stringify({ deletionRequestId: request.id, status: "COMPLETED" }),
          metadata: { deletionRequestId: request.id, tombstone: true },
        },
        tx
      );
    });
  }

  return { completed, blocked };
}

export function isActiveMealDeletionStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_REQUEST_STATES.includes(status);
}
'''
)

# ---------------------------------------------------------------------------
# Make lazy meal materialization advance due retirements before selecting defs.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/domain/meal-engine.ts",
    'import { ApiError, CODES } from "@/lib/errors";\n',
    'import { ApiError, CODES } from "@/lib/errors";\nimport { refreshDueMealDefinitionRetirements } from "@/lib/domain/meal-retirement";\n'
)
replace_once(
    "src/lib/domain/meal-engine.ts",
    '''  if (fromKey > toKey) return 0;
  const defs = (await client.mealDefinition.findMany({''',
    '''  if (fromKey > toKey) return 0;
  await refreshDueMealDefinitionRetirements(institutionId, client);
  const defs = (await client.mealDefinition.findMany({'''
)

# ---------------------------------------------------------------------------
# Admin list: advance due requests, expose current lifecycle, hide completed
# tombstones from live configuration.
# ---------------------------------------------------------------------------
write(
    "src/app/api/v1/admin/meal-definitions/route.ts",
    '''/**
 * GET /api/v1/admin/meal-definitions — live definitions with retirement state.
 * POST /api/v1/admin/meal-definitions — create definition + immutable v1.
 */
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { localDateMidnightUtc } from "@/lib/time";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext, snapshotConfig } from "@/lib/domain/meal-engine";
import { refreshDueMealDefinitionRetirements } from "@/lib/domain/meal-retirement";
import {
  mealDefinitionCreateSchema,
  validateDefinitionInvariants,
} from "@/lib/domain/meal-definition-schema";

function serializeDeletionRequest(row: Record<string, any> | null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    requestedAt: new Date(row.requestedAt).toISOString(),
    scheduledFor: row.scheduledFor ? new Date(row.scheduledFor).toISOString() : null,
    reason: row.reason ?? null,
    blockedReason: row.blockedReason ?? null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    cancelReason: row.cancelReason ?? null,
    cancelledByUserId: row.cancelledByUserId ?? null,
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
  };
}

function serializeDefinition(
  def: Record<string, any>,
  latestVersion: Record<string, any> | null,
  latestDeletion: Record<string, any> | null = null
) {
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
    deletionRequest: serializeDeletionRequest(latestDeletion),
    createdAt: new Date(def.createdAt).toISOString(),
    updatedAt: new Date(def.updatedAt).toISOString(),
    latestVersion: latestVersion
      ? { id: latestVersion.id, version: latestVersion.version, createdAt: new Date(latestVersion.createdAt).toISOString() }
      : null,
  };
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  await refreshDueMealDefinitionRetirements(ctx.institutionId);

  const defs = await db.mealDefinition.findMany({
    where: { institutionId: ctx.institutionId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const ids = defs.map((row) => row.id);
  const requests = ids.length
    ? await db.deletionRequest.findMany({
        where: {
          institutionId: ctx.institutionId,
          entityType: "MEAL_DEFINITION",
          entityId: { in: ids },
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      })
    : [];
  const latestByDefinition = new Map<string, (typeof requests)[number]>();
  for (const request of requests) {
    if (!latestByDefinition.has(request.entityId)) latestByDefinition.set(request.entityId, request);
  }

  const data = defs
    .filter((definition) => latestByDefinition.get(definition.id)?.status !== "COMPLETED")
    .map((definition) =>
      serializeDefinition(
        definition as never,
        (definition.versions?.[0] ?? null) as never,
        (latestByDefinition.get(definition.id) ?? null) as never
      )
    );
  const active = data.filter((row) => row.archivedAt == null).length;
  const pendingDeletion = data.filter((row) =>
    ["QUEUED", "SCHEDULED", "BLOCKED"].includes(row.deletionRequest?.status ?? "")
  ).length;
  return {
    data,
    meta: { configured: data.length, active, inactive: data.length - active, pendingDeletion },
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
      created.version as unknown as Record<string, any>,
      null
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
'''
)

# ---------------------------------------------------------------------------
# Detail/update lifecycle guards.
# ---------------------------------------------------------------------------
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''import {
  mealDefinitionUpdateSchema,
  validateDefinitionInvariants,
} from "@/lib/domain/meal-definition-schema";''',
    '''import {
  mealDefinitionUpdateSchema,
  validateDefinitionInvariants,
} from "@/lib/domain/meal-definition-schema";
import { refreshDueMealDefinitionRetirements } from "@/lib/domain/meal-retirement";'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const def = await db.mealDefinition.findFirst({''',
    '''export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  await refreshDueMealDefinitionRetirements(ctx.institutionId);
  const def = await db.mealDefinition.findFirst({'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''  if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
  return {
    data: {
      ...serializeDefinition(def as never),
      versions: ((def.versions ?? []) as Record<string, any>[]).map(serializeVersion),
    },
  };
});''',
    '''  if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
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
});'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''export const PUT = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const patch = await parseBody(ctx.req, mealDefinitionUpdateSchema);''',
    '''export const PUT = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  await refreshDueMealDefinitionRetirements(ctx.institutionId);
  const patch = await parseBody(ctx.req, mealDefinitionUpdateSchema);'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''    if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);

    // Merge patch onto the current config and validate the RESULT as a whole.''',
    '''    if (!def) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
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

    // Merge patch onto the current config and validate the RESULT as a whole.'''
)

# ---------------------------------------------------------------------------
# Thin API routes for schedule/cancel/restore.
# ---------------------------------------------------------------------------
write(
    "src/app/api/v1/admin/meal-definitions/[id]/request-deletion/route.ts",
    '''/** Schedule a meal-definition tombstone after a 30-day safety window. */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { scheduleMealDefinitionDeletion } from "@/lib/domain/meal-retirement";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);
  const result = await scheduleMealDefinitionDeletion({
    institutionId: ctx.institutionId,
    mealDefinitionId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
  });

  return {
    data: {
      deletionRequestId: result.request.id,
      definitionId: result.definition.id,
      status: result.request.status,
      scheduledFor: result.request.scheduledFor?.toISOString() ?? null,
      reason: result.request.reason,
      active: result.definition.active,
      archivedAt: result.definition.archivedAt?.toISOString() ?? null,
    },
  };
});
'''
)

write(
    "src/app/api/v1/admin/meal-definitions/[id]/cancel-deletion/route.ts",
    '''/** Cancel a pending/blocked meal-definition deletion without erasing history. */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { reasonSchema } from "@/lib/validation";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { cancelMealDefinitionDeletion } from "@/lib/domain/meal-retirement";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const body = await parseBody(ctx.req, bodySchema);
  const result = await cancelMealDefinitionDeletion({
    institutionId: ctx.institutionId,
    mealDefinitionId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
    reason: body.reason,
  });

  return {
    data: {
      deletionRequestId: result.request.id,
      definitionId: result.definition.id,
      status: result.request.status,
      cancelReason: result.request.cancelReason,
      cancelledAt: result.request.cancelledAt?.toISOString() ?? null,
      active: result.definition.active,
      archivedAt: result.definition.archivedAt?.toISOString() ?? null,
      deleteRequestedAt: result.definition.deleteRequestedAt?.toISOString() ?? null,
    },
  };
});
'''
)

write(
    "src/app/api/v1/admin/meal-definitions/[id]/restore/route.ts",
    '''/** Restore an archived definition when no deletion lifecycle is active/completed. */
import { route } from "@/lib/auth/guard";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { restoreMealDefinition } from "@/lib/domain/meal-retirement";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);
  const definition = await restoreMealDefinition({
    institutionId: ctx.institutionId,
    mealDefinitionId: ctx.params.id,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
  });

  return {
    data: {
      id: definition.id,
      name: definition.name,
      active: definition.active,
      archivedAt: definition.archivedAt?.toISOString() ?? null,
    },
  };
});
'''
)

# ---------------------------------------------------------------------------
# Admin client contract.
# ---------------------------------------------------------------------------
replace_once(
    "src/components/app/admin/_shared/types.ts",
    '''  archivedAt: string | null;
  deleteRequestedAt: string | null;
  createdAt: string;''',
    '''  archivedAt: string | null;
  deleteRequestedAt: string | null;
  deletionRequest: {
    id: string;
    status: "QUEUED" | "SCHEDULED" | "BLOCKED" | "COMPLETED" | "CANCELLED" | string;
    requestedAt: string;
    scheduledFor: string | null;
    reason: string | null;
    blockedReason: string | null;
    completedAt: string | null;
    cancelReason: string | null;
    cancelledByUserId: string | null;
    cancelledAt: string | null;
  } | null;
  createdAt: string;'''
)

# ---------------------------------------------------------------------------
# Admin Meal Configuration lifecycle UX.
# ---------------------------------------------------------------------------
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''  Plus,
  Settings2,
  Trash2,
  Utensils,''',
    '''  Plus,
  RotateCcw,
  Settings2,
  Trash2,
  Utensils,'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''  const [archiveTarget, setArchiveTarget] = useState<MealDefinitionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MealDefinitionRow | null>(null);
  const [acting, setActing] = useState(false);''',
    '''  const [archiveTarget, setArchiveTarget] = useState<MealDefinitionRow | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<MealDefinitionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MealDefinitionRow | null>(null);
  const [cancelDeletionTarget, setCancelDeletionTarget] = useState<MealDefinitionRow | null>(null);
  const [acting, setActing] = useState(false);'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''      toast.success("Deletion queued", {
        description: `${target.name} will be removed after the 30-day safety window.`,
      });''',
    '''      toast.success("Deletion scheduled", {
        description: `${target.name} is archived now and leaves live configuration after the 30-day safety window.`,
      });'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''  async function requestDeletion(target: MealDefinitionRow, reason: string | undefined) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/request-deletion`, { reason });
      invalidate([DEFS_PATH]);
      toast.success("Deletion scheduled", {
        description: `${target.name} is archived now and leaves live configuration after the 30-day safety window.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  if (isLoading && !envelope) {''',
    '''  async function requestDeletion(target: MealDefinitionRow, reason: string | undefined) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/request-deletion`, { reason });
      invalidate([DEFS_PATH]);
      toast.success("Deletion scheduled", {
        description: `${target.name} is archived now and leaves live configuration after the 30-day safety window.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function restore(target: MealDefinitionRow) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/restore`, {});
      invalidate([DEFS_PATH]);
      toast.success("Meal restored", {
        description: `${target.name} can generate future matching services again.`,
      });
      setRestoreTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function cancelDeletion(target: MealDefinitionRow, reason: string | undefined) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/cancel-deletion`, { reason });
      invalidate([DEFS_PATH]);
      toast.success("Deletion cancelled", {
        description: `${target.name} remains archived. Restore it separately if it should return to service.`,
      });
      setCancelDeletionTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  if (isLoading && !envelope) {'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''              const Icon = mealIcon(def.icon);
              const inactive = def.archivedAt != null;
              const hex = mealHex(def.colorToken);''',
    '''              const Icon = mealIcon(def.icon);
              const inactive = def.archivedAt != null;
              const deletionPending = ["QUEUED", "SCHEDULED", "BLOCKED"].includes(def.deletionRequest?.status ?? "");
              const hex = mealHex(def.colorToken);'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''                          <StatusBadge status={inactive ? "INACTIVE" : "ACTIVE"} />''',
    '''                          <StatusBadge status={deletionPending ? "PENDING_DELETION" : inactive ? "INACTIVE" : "ACTIVE"} />'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''                        <ViewButton
                          label="Edit"
                          onClick={() => {
                            setEditingDef(def);
                            setWizardOpen(true);
                          }}
                        />
                        <OverflowMenu''',
    '''                        {!deletionPending && (
                          <ViewButton
                            label="Edit"
                            onClick={() => {
                              setEditingDef(def);
                              setWizardOpen(true);
                            }}
                          />
                        )}
                        <OverflowMenu'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''                            {
                              key: "edit",
                              label: "Edit (new version)",
                              icon: <Settings2 />,
                              onSelect: () => {
                                setEditingDef(def);
                                setWizardOpen(true);
                              },
                              separatorBefore: true,
                            },
                            ...(inactive
                              ? []
                              : [{ key: "archive", label: "Archive", icon: <Archive />, onSelect: () => setArchiveTarget(def), separatorBefore: true }]),
                            ...(def.deleteRequestedAt
                              ? []
                              : [{ key: "delete", label: "Request deletion…", icon: <Trash2 />, onSelect: () => setDeleteTarget(def), destructive: true }]),''',
    '''                            ...(!deletionPending
                              ? [{
                                  key: "edit",
                                  label: "Edit (new version)",
                                  icon: <Settings2 />,
                                  onSelect: () => {
                                    setEditingDef(def);
                                    setWizardOpen(true);
                                  },
                                  separatorBefore: true,
                                }]
                              : []),
                            ...(!deletionPending && !inactive
                              ? [{ key: "archive", label: "Archive", icon: <Archive />, onSelect: () => setArchiveTarget(def), separatorBefore: true }]
                              : []),
                            ...(!deletionPending && inactive
                              ? [{ key: "restore", label: "Restore", icon: <RotateCcw />, onSelect: () => setRestoreTarget(def), separatorBefore: true }]
                              : []),
                            ...(deletionPending
                              ? [{ key: "cancel-delete", label: "Cancel deletion…", icon: <RotateCcw />, onSelect: () => setCancelDeletionTarget(def), separatorBefore: true }]
                              : [{ key: "delete", label: "Request deletion…", icon: <Trash2 />, onSelect: () => setDeleteTarget(def), destructive: true }]),'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''                    {def.deleteRequestedAt && (
                      <p className="rounded-md bg-danger/10 px-2.5 py-1 text-[11px] font-medium text-danger">
                        Deletion queued — {fmtDate(def.deleteRequestedAt)}
                      </p>
                    )}''',
    '''                    {deletionPending && (
                      <p className="rounded-md bg-danger/10 px-2.5 py-1 text-[11px] font-medium text-danger">
                        {def.deletionRequest?.status === "BLOCKED"
                          ? `Deletion blocked — ${def.deletionRequest.blockedReason ?? "Needs Admin review"}`
                          : `Deletion scheduled${def.deletionRequest?.scheduledFor ? ` — ${fmtDate(def.deletionRequest.scheduledFor)}` : ""}`}
                      </p>
                    )}'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''          description="Future services stop being generated. Residents' existing meals and all history stay intact. This can be reversed by editing the meal."
          confirmLabel="Archive meal"''',
    '''          description="Future services stop being generated. Residents' existing meals and all history stay intact. Restore the meal explicitly if it should return to service."
          confirmLabel="Archive meal"'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''      {/* deletion queue */}
      {deleteTarget && (
        <ConfirmDialog''',
    '''      {/* restore archive */}
      {restoreTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRestoreTarget(null)}
          title={`Restore ${restoreTarget.name}`}
          description="This reactivates the definition so future matching services may be generated again. Historical service versions remain unchanged."
          confirmLabel="Restore meal"
          tone="primary"
          loading={acting}
          onConfirm={() => void restore(restoreTarget)}
        />
      )}

      {/* deletion queue */}
      {deleteTarget && (
        <ConfirmDialog'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''          description="This queues the definition for deletion after a 30-day safety window, during which the request can be reviewed in the audit trail. The full version history is preserved."
          confirmLabel="Queue deletion"''',
    '''          description="This archives the meal immediately, then schedules a tombstone after a 30-day safety window. The definition's versions and historical meal records are never destroyed."
          confirmLabel="Schedule deletion"'''
)
replace_once(
    "src/components/app/admin/meal-configuration.tsx",
    '''      )}
    </StaggerGroup>
  );
}''',
    '''      )}

      {cancelDeletionTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setCancelDeletionTarget(null)}
          title={`Cancel deletion — ${cancelDeletionTarget.name}`}
          description="The deletion request stays in history as CANCELLED. The meal remains archived until you explicitly restore it."
          confirmLabel="Cancel deletion"
          tone="destructive"
          requireReason
          reasonPlaceholder="Why is this deletion being cancelled? (required)"
          loading={acting}
          onConfirm={(reason) => void cancelDeletion(cancelDeletionTarget, reason)}
        />
      )}
    </StaggerGroup>
  );
}'''
)

# ---------------------------------------------------------------------------
# PostgreSQL lifecycle regressions.
# ---------------------------------------------------------------------------
write(
    "tests/integration/meal-retirement-lifecycle.test.ts",
    '''import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { ensureInstancesForRange } from "@/lib/domain/meal-engine";
import {
  cancelMealDefinitionDeletion,
  refreshDueMealDefinitionRetirements,
  restoreMealDefinition,
  scheduleMealDefinitionDeletion,
} from "@/lib/domain/meal-retirement";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function fixture() {
  const institution = await db.institution.create({ data: { name: unique("Retirement Mess"), timezone: "UTC" } });
  const admin = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "ADMIN",
      status: "ACTIVE",
      email: `${unique("retirement-admin")}@example.test`,
      passwordHash: "integration-test-only",
    },
  });
  const definition = await db.mealDefinition.create({
    data: { institutionId: institution.id, name: unique("Retirement Meal") },
  });
  return { institution, admin, definition };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("meal-definition retirement lifecycle", () => {
  test("schedule archives immediately, cancellation preserves history, and explicit restore reactivates generation", async () => {
    const { institution, admin, definition } = await fixture();
    const scheduledAt = new Date("2026-09-01T00:00:00.000Z");

    const scheduled = await scheduleMealDefinitionDeletion({
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      actorUserId: admin.id,
      requestId: unique("schedule-request"),
      reason: "Retire this meal safely",
      now: scheduledAt,
    });
    expect(scheduled.request.status).toBe("SCHEDULED");
    expect(scheduled.request.scheduledFor?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(scheduled.definition.active).toBe(false);
    expect(scheduled.definition.archivedAt?.toISOString()).toBe(scheduledAt.toISOString());
    expect(scheduled.definition.deleteRequestedAt?.toISOString()).toBe(scheduledAt.toISOString());

    const whileArchived = await ensureInstancesForRange(institution.id, "UTC", "2099-01-10", "2099-01-10");
    expect(whileArchived).toBe(0);

    const cancelled = await cancelMealDefinitionDeletion({
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      actorUserId: admin.id,
      requestId: unique("cancel-request"),
      reason: "Meal is needed again",
      now: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(cancelled.request.status).toBe("CANCELLED");
    expect(cancelled.request.cancelReason).toBe("Meal is needed again");
    expect(cancelled.request.cancelledByUserId).toBe(admin.id);
    expect(cancelled.request.cancelledAt?.toISOString()).toBe("2026-09-02T00:00:00.000Z");
    expect(cancelled.definition.deleteRequestedAt).toBeNull();
    expect(cancelled.definition.archivedAt).not.toBeNull();
    expect(cancelled.definition.active).toBe(false);

    const restored = await restoreMealDefinition({
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      actorUserId: admin.id,
      requestId: unique("restore-request"),
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(restored.active).toBe(true);
    expect(restored.archivedAt).toBeNull();

    const afterRestore = await ensureInstancesForRange(institution.id, "UTC", "2099-01-10", "2099-01-10");
    expect(afterRestore).toBe(1);
  });

  test("due legacy queued deletion completes as a tombstone and cannot be restored", async () => {
    const { institution, admin, definition } = await fixture();
    const requestedAt = new Date("2026-07-01T00:00:00.000Z");
    const request = await db.deletionRequest.create({
      data: {
        institutionId: institution.id,
        entityType: "MEAL_DEFINITION",
        entityId: definition.id,
        requestedByUserId: admin.id,
        requestedAt,
        scheduledFor: new Date("2026-07-31T00:00:00.000Z"),
        reason: "Legacy queued request",
        status: "QUEUED",
      },
    });
    await db.mealDefinition.update({
      where: { id: definition.id },
      data: { deleteRequestedAt: requestedAt, active: true, archivedAt: null },
    });

    const sweep = await refreshDueMealDefinitionRetirements(
      institution.id,
      db,
      new Date("2026-08-05T00:00:00.000Z")
    );
    expect(sweep).toEqual({ completed: 1, blocked: 0 });

    const completed = await db.deletionRequest.findUniqueOrThrow({ where: { id: request.id } });
    const retired = await db.mealDefinition.findUniqueOrThrow({ where: { id: definition.id } });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt?.toISOString()).toBe("2026-08-05T00:00:00.000Z");
    expect(retired.active).toBe(false);
    expect(retired.archivedAt).not.toBeNull();
    expect(retired.deleteRequestedAt).not.toBeNull();

    let caught: unknown;
    try {
      await restoreMealDefinition({
        institutionId: institution.id,
        mealDefinitionId: definition.id,
        actorUserId: admin.id,
        requestId: unique("forbidden-restore"),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toContain("deletion request");
  });

  test("a due request whose referenced definition is missing is BLOCKED rather than falsely completed", async () => {
    const institution = await db.institution.create({ data: { name: unique("Blocked Retirement Mess") } });
    const request = await db.deletionRequest.create({
      data: {
        institutionId: institution.id,
        entityType: "MEAL_DEFINITION",
        entityId: unique("missing-definition"),
        requestedByUserId: unique("admin"),
        requestedAt: new Date("2026-01-01T00:00:00.000Z"),
        scheduledFor: new Date("2026-01-31T00:00:00.000Z"),
        reason: "Corrupted fixture",
        status: "SCHEDULED",
      },
    });

    const sweep = await refreshDueMealDefinitionRetirements(
      institution.id,
      db,
      new Date("2026-02-01T00:00:00.000Z")
    );
    expect(sweep).toEqual({ completed: 0, blocked: 1 });
    const blocked = await db.deletionRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.completedAt).toBeNull();
    expect(blocked.blockedReason).toContain("manual reconciliation");
  });
});
'''
)

write(
    "tests/unit/meal-retirement-lifecycle-source.test.ts",
    '''import { describe, expect, test } from "bun:test";

const schema = await Bun.file("prisma/schema.prisma").text();
const migration = await Bun.file(
  "prisma/migrations/20260906_080000_meal_definition_retirement_lifecycle/migration.sql"
).text();
const domain = await Bun.file("src/lib/domain/meal-retirement.ts").text();
const engine = await Bun.file("src/lib/domain/meal-engine.ts").text();
const listRoute = await Bun.file("src/app/api/v1/admin/meal-definitions/route.ts").text();
const detailRoute = await Bun.file("src/app/api/v1/admin/meal-definitions/[id]/route.ts").text();
const scheduleRoute = await Bun.file(
  "src/app/api/v1/admin/meal-definitions/[id]/request-deletion/route.ts"
).text();
const cancelRoute = await Bun.file(
  "src/app/api/v1/admin/meal-definitions/[id]/cancel-deletion/route.ts"
).text();
const restoreRoute = await Bun.file("src/app/api/v1/admin/meal-definitions/[id]/restore/route.ts").text();
const ui = await Bun.file("src/components/app/admin/meal-configuration.tsx").text();

describe("meal-definition retirement source contracts", () => {
  test("deletion request persists cancellation provenance and a due-sweep index", () => {
    expect(schema).toContain("cancelReason      String?");
    expect(schema).toContain("cancelledByUserId String?");
    expect(schema).toContain("cancelledAt       DateTime?");
    expect(schema).toContain("@@index([institutionId, entityType, status, scheduledFor])");
    expect(migration).toContain("SET \"status\" = 'SCHEDULED'");
    expect(migration).toContain("\"archivedAt\" = COALESCE");
    expect(migration).toContain("\"active\" = FALSE");
  });

  test("scheduling archives immediately and persists SCHEDULED instead of dead QUEUED copy", () => {
    expect(domain).toContain('status: "SCHEDULED"');
    expect(domain).toContain("archivedAt: definition.archivedAt ?? now");
    expect(domain).toContain("deleteRequestedAt: now");
    expect(scheduleRoute).toContain("scheduleMealDefinitionDeletion");
  });

  test("due requests are guarded to COMPLETED or fail closed as BLOCKED", () => {
    expect(domain).toContain('status: "COMPLETED", completedAt: now');
    expect(domain).toContain('status: "BLOCKED"');
    expect(domain).toContain("manual reconciliation is required");
    expect(engine.indexOf("refreshDueMealDefinitionRetirements")).toBeLessThan(
      engine.indexOf("client.mealDefinition.findMany")
    );
  });

  test("Admin reads advance lifecycle and remove completed tombstones from live configuration", () => {
    expect(listRoute).toContain("await refreshDueMealDefinitionRetirements(ctx.institutionId)");
    expect(listRoute).toContain('status !== "COMPLETED"');
    expect(listRoute).toContain("deletionRequest: serializeDeletionRequest");
    expect(detailRoute).toContain("has completed its deletion lifecycle");
  });

  test("editing cannot mutate a pending or completed retirement and restore is explicit", () => {
    expect(detailRoute).toContain("Cancel the deletion request before editing this meal definition.");
    expect(detailRoute).toContain("A completed deletion tombstone cannot be edited.");
    expect(restoreRoute).toContain("restoreMealDefinition");
    expect(domain).toContain("A completed deletion tombstone cannot be restored.");
  });

  test("cancellation is reasoned, audited and leaves archive state intact", () => {
    expect(cancelRoute).toContain("reasonSchema");
    expect(cancelRoute).toContain("cancelMealDefinitionDeletion");
    expect(domain).toContain('action: "MEAL_DELETION_CANCELLED"');
    expect(domain).toContain("data: { deleteRequestedAt: null }");
    expect(domain).not.toContain("data: { deleteRequestedAt: null, archivedAt: null }");
  });

  test("Admin UI exposes Restore/Cancel deletion and no longer claims editing restores archives", () => {
    expect(ui).toContain('label: "Restore"');
    expect(ui).toContain('label: "Cancel deletion…"');
    expect(ui).toContain("The deletion request stays in history as CANCELLED");
    expect(ui).toContain("Restore the meal explicitly");
    expect(ui).not.toContain("This can be reversed by editing the meal.");
  });
});
'''
)

print("Phase 46 guarded production/test patch prepared")
