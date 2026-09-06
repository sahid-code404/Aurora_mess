import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

const ENTITY_TYPE = "USER";
const DAY_MS = 86_400_000;
export const RESIDENT_DELETION_GRACE_DAYS = 7;
const ACTIVE_REQUEST_STATES = ["QUEUED", "SCHEDULED", "BLOCKED"];
const DUE_REQUEST_STATES = ["QUEUED", "SCHEDULED"];
const UNFINISHED_TASK_STATES = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "SUBMITTED"];

type Client = any;

type ActorInput = {
  institutionId: string;
  residentId: string;
  actorUserId: string;
  requestId: string;
  now?: Date;
};

async function inTransaction<T>(client: Client, fn: (tx: Client) => Promise<T>): Promise<T> {
  if (typeof client?.$transaction === "function") return client.$transaction(fn);
  return fn(client);
}

function formatScheduledDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function completeDueRequest(
  tx: Client,
  request: { id: string; entityId: string; status: string; scheduledFor: Date | null },
  institutionId: string,
  now: Date
): Promise<boolean> {
  if (!request.scheduledFor || request.scheduledFor.getTime() > now.getTime()) return false;

  const guard = await tx.deletionRequest.updateMany({
    where: { id: request.id, status: { in: DUE_REQUEST_STATES }, scheduledFor: { lte: now } },
    data: { status: "COMPLETED", completedAt: now, blockedReason: null },
  });
  if (guard.count !== 1) return false;

  await appendAudit(
    {
      institutionId,
      actorUserId: null,
      actorRole: "SYSTEM",
      action: "RESIDENT_DELETION_COMPLETED",
      entityType: ENTITY_TYPE,
      entityId: request.entityId,
      reason: `${RESIDENT_DELETION_GRACE_DAYS}-day resident deletion safety window elapsed. Historical records were retained.`,
      beforeSummary: JSON.stringify({ deletionRequestId: request.id, status: request.status }),
      afterSummary: JSON.stringify({
        deletionRequestId: request.id,
        status: "COMPLETED",
        residentStatus: "PENDING_DELETION",
        historicalDataRetained: true,
      }),
      metadata: { deletionRequestId: request.id, historicalDataRetained: true },
    },
    tx
  );

  return true;
}

/**
 * ACTIVE -> PENDING_DELETION with a seven-day reversible safety window.
 *
 * The User row is retained permanently as the financial/history identity. The
 * DeletionRequest carries the grace-period lifecycle; completion creates a
 * tombstone rather than erasing bills, payments, refunds, meals or audit data.
 */
export async function scheduleResidentDeletion(
  input: ActorInput & { reason: string },
  client: Client = db
) {
  const now = input.now ?? new Date();
  return inTransaction(client, async (tx) => {
    await lockResidentLifecycleMutation(tx, input.institutionId, input.residentId);

    const resident = await tx.user.findUnique({ where: { id: input.residentId } });
    if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
    if (resident.status !== "ACTIVE") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Only active residents can be moved to the deletion queue (currently ${resident.status
          .replace(/_/g, " ")
          .toLowerCase()}).`,
        409
      );
    }

    const unfinishedTaskCount = await tx.task.count({
      where: {
        institutionId: input.institutionId,
        assignedResidentId: resident.id,
        status: { in: UNFINISHED_TASK_STATES },
      },
    });
    if (unfinishedTaskCount > 0) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Resolve or reassign ${unfinishedTaskCount} unfinished task${unfinishedTaskCount === 1 ? "" : "s"} before deleting this resident.`,
        409
      );
    }

    const activeRequest = await tx.deletionRequest.findFirst({
      where: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: resident.id,
        status: { in: ACTIVE_REQUEST_STATES },
      },
      orderBy: { requestedAt: "desc" },
    });
    if (activeRequest) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This resident already has an active deletion request.", 409);
    }

    const scheduledFor = new Date(now.getTime() + RESIDENT_DELETION_GRACE_DAYS * DAY_MS);
    const request = await tx.deletionRequest.create({
      data: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: resident.id,
        requestedByUserId: input.actorUserId,
        requestedAt: now,
        scheduledFor,
        reason: input.reason,
        status: "SCHEDULED",
      },
    });

    const updated = await tx.user.update({
      where: { id: resident.id },
      data: { status: "PENDING_DELETION" },
    });
    await tx.userStatusHistory.create({
      data: {
        userId: resident.id,
        fromStatus: "ACTIVE",
        toStatus: "PENDING_DELETION",
        changedByUserId: input.actorUserId,
        reason: input.reason,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "RESIDENT_DELETION_SCHEDULED",
        entityType: ENTITY_TYPE,
        entityId: resident.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: JSON.stringify({ status: "ACTIVE" }),
        afterSummary: JSON.stringify({
          status: "PENDING_DELETION",
          deletionRequestId: request.id,
          deletionStatus: request.status,
          scheduledFor: scheduledFor.toISOString(),
        }),
        metadata: { deletionRequestId: request.id, scheduledFor: scheduledFor.toISOString() },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: resident.id,
        institutionId: input.institutionId,
        type: "ACCOUNT_DELETION_SCHEDULED",
        title: "Account scheduled for deletion",
        message: `Your account has been moved to the deletion queue until ${formatScheduledDate(scheduledFor)}. Historical financial records will be retained. Reason: ${input.reason}`,
        entityRef: resident.id,
      },
      tx
    );

    return { resident: updated, request };
  });
}

/** Cancel a still-open grace period and restore PENDING_DELETION -> ACTIVE. */
export async function cancelResidentDeletion(
  input: ActorInput & { reason: string },
  client: Client = db
) {
  const now = input.now ?? new Date();
  const result = await inTransaction(client, async (tx) => {
    await lockResidentLifecycleMutation(tx, input.institutionId, input.residentId);

    const resident = await tx.user.findUnique({ where: { id: input.residentId } });
    if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
    if (resident.status !== "PENDING_DELETION") {
      throw new ApiError(CODES.VALIDATION_FAILED, "This resident is not in the deletion queue.", 409);
    }

    const request = await tx.deletionRequest.findFirst({
      where: {
        institutionId: input.institutionId,
        entityType: ENTITY_TYPE,
        entityId: resident.id,
        status: { in: DUE_REQUEST_STATES },
      },
      orderBy: { requestedAt: "desc" },
    });

    if (!request) {
      const completed = await tx.deletionRequest.findFirst({
        where: {
          institutionId: input.institutionId,
          entityType: ENTITY_TYPE,
          entityId: resident.id,
          status: "COMPLETED",
        },
        orderBy: { completedAt: "desc" },
      });
      if (completed) return { expired: true as const, request: completed };
      throw new ApiError(CODES.VALIDATION_FAILED, "There is no active resident deletion request to cancel.", 409);
    }

    if (request.scheduledFor && request.scheduledFor.getTime() <= now.getTime()) {
      await completeDueRequest(tx, request, input.institutionId, now);
      return {
        expired: true as const,
        request: await tx.deletionRequest.findUniqueOrThrow({ where: { id: request.id } }),
      };
    }

    const guard = await tx.deletionRequest.updateMany({
      where: { id: request.id, status: { in: DUE_REQUEST_STATES } },
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

    const updated = await tx.user.update({ where: { id: resident.id }, data: { status: "ACTIVE" } });
    await tx.userStatusHistory.create({
      data: {
        userId: resident.id,
        fromStatus: "PENDING_DELETION",
        toStatus: "ACTIVE",
        changedByUserId: input.actorUserId,
        reason: input.reason,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "RESIDENT_DELETION_CANCELLED",
        entityType: ENTITY_TYPE,
        entityId: resident.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: JSON.stringify({
          status: "PENDING_DELETION",
          deletionRequestId: request.id,
          deletionStatus: request.status,
        }),
        afterSummary: JSON.stringify({ status: "ACTIVE", deletionRequestId: request.id, deletionStatus: "CANCELLED" }),
        metadata: { deletionRequestId: request.id },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: resident.id,
        institutionId: input.institutionId,
        type: "ACCOUNT_DELETION_CANCELLED",
        title: "Account deletion cancelled",
        message: `Your account has been restored to active status. Reason: ${input.reason}`,
        entityRef: resident.id,
      },
      tx
    );

    return {
      expired: false as const,
      resident: updated,
      request: await tx.deletionRequest.findUniqueOrThrow({ where: { id: request.id } }),
    };
  });

  if (result.expired) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "The seven-day deletion safety window has already elapsed. This resident is now a retained historical tombstone and cannot be restored.",
      409
    );
  }
  return result;
}

/**
 * Persist terminal completion for due resident deletion requests. Completion
 * never deletes the User row or financial/history records; the resident stays
 * PENDING_DELETION as a non-loginable tombstone.
 */
export async function refreshDueResidentRetirements(
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
      const resident = await tx.user.findFirst({
        where: { id: candidate.entityId, institutionId, role: "RESIDENT" },
        select: { id: true },
      });
      if (!resident) {
        const guard = await tx.deletionRequest.updateMany({
          where: { id: candidate.id, status: { in: DUE_REQUEST_STATES } },
          data: {
            status: "BLOCKED",
            blockedReason: "The referenced resident no longer exists; manual reconciliation is required.",
          },
        });
        if (guard.count === 1) blocked += 1;
        return;
      }

      await lockResidentLifecycleMutation(tx, institutionId, resident.id);
      const [request, authoritativeResident] = await Promise.all([
        tx.deletionRequest.findFirst({
          where: {
            id: candidate.id,
            institutionId,
            entityType: ENTITY_TYPE,
            status: { in: DUE_REQUEST_STATES },
            scheduledFor: { lte: now },
          },
        }),
        tx.user.findUnique({ where: { id: resident.id } }),
      ]);
      if (!request) return;

      if (!authoritativeResident || authoritativeResident.status !== "PENDING_DELETION") {
        const guard = await tx.deletionRequest.updateMany({
          where: { id: request.id, status: { in: DUE_REQUEST_STATES } },
          data: {
            status: "BLOCKED",
            blockedReason: `Resident status is ${authoritativeResident?.status ?? "missing"}; expected PENDING_DELETION.`,
          },
        });
        if (guard.count === 1) {
          blocked += 1;
          await appendAudit(
            {
              institutionId,
              actorUserId: null,
              actorRole: "SYSTEM",
              action: "RESIDENT_DELETION_BLOCKED",
              entityType: ENTITY_TYPE,
              entityId: resident.id,
              reason: "Resident status diverged from the deletion request lifecycle.",
              afterSummary: JSON.stringify({ deletionRequestId: request.id, status: "BLOCKED" }),
              metadata: { deletionRequestId: request.id },
            },
            tx
          );
        }
        return;
      }

      if (await completeDueRequest(tx, request, institutionId, now)) completed += 1;
    });
  }

  return { completed, blocked };
}

export function serializeResidentDeletionRequest(request: any | null) {
  if (!request) return null;
  return {
    id: request.id,
    status: request.status,
    requestedAt: request.requestedAt?.toISOString?.() ?? request.requestedAt,
    scheduledFor: request.scheduledFor?.toISOString?.() ?? request.scheduledFor ?? null,
    reason: request.reason ?? null,
    blockedReason: request.blockedReason ?? null,
    completedAt: request.completedAt?.toISOString?.() ?? request.completedAt ?? null,
    cancelReason: request.cancelReason ?? null,
    cancelledByUserId: request.cancelledByUserId ?? null,
    cancelledAt: request.cancelledAt?.toISOString?.() ?? request.cancelledAt ?? null,
  };
}
