import { db } from "@/lib/db";
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
