import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type AnnouncementLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type AnnouncementReadClient = Pick<Prisma.TransactionClient, "announcement" | "auditEvent">;

type AnnouncementLike = {
  id: string;
  institutionId: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  target: string;
  publishAt: Date;
  expiresAt: Date | null;
  pinned: boolean;
  createdByUserId: string | null;
  createdAt: Date;
};

const LIFECYCLE_ACTIONS = [
  "ANNOUNCEMENT_ARCHIVED",
  "ANNOUNCEMENT_UNARCHIVED",
  "ANNOUNCEMENT_REPUBLISHED",
] as const;

export type AnnouncementLifecycleState = {
  archived: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  archivedByUserId: string | null;
  lastTransitionAt: Date | null;
};

const ACTIVE_STATE: AnnouncementLifecycleState = {
  archived: false,
  archivedAt: null,
  archiveReason: null,
  archivedByUserId: null,
  lastTransitionAt: null,
};

/** Serialize every mutation of one Announcement row. */
export async function lockAnnouncementMutation(
  client: AnnouncementLockClient,
  institutionId: string,
  announcementId: string
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Announcement"
    WHERE "id" = ${announcementId}
      AND "institutionId" = ${institutionId}
    FOR UPDATE
  `);

  if (rows.length !== 1) {
    throw new ApiError(CODES.NOT_FOUND, "Announcement not found.", 404);
  }
}

/** Re-read the authoritative row only after lockAnnouncementMutation(). */
export async function requireAnnouncementAfterLock(
  client: AnnouncementReadClient,
  institutionId: string,
  announcementId: string
) {
  const row = await client.announcement.findUnique({ where: { id: announcementId } });
  if (!row || row.institutionId !== institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Announcement not found.", 404);
  }
  return row;
}

/**
 * Archive state is event-sourced from the append-only AuditEvent stream.
 * REPUBLISHED is an explicit reactivation, so it has the same lifecycle effect
 * as UNARCHIVED while still retaining its distinct audit meaning.
 */
export async function announcementLifecycleStates(
  client: AnnouncementReadClient,
  institutionId: string,
  announcementIds: string[]
): Promise<Map<string, AnnouncementLifecycleState>> {
  const ids = [...new Set(announcementIds)];
  const out = new Map<string, AnnouncementLifecycleState>();
  if (ids.length === 0) return out;

  const events = await client.auditEvent.findMany({
    where: {
      institutionId,
      entityType: "ANNOUNCEMENT",
      entityId: { in: ids },
      action: { in: [...LIFECYCLE_ACTIONS] },
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      entityId: true,
      action: true,
      occurredAt: true,
      reason: true,
      actorUserId: true,
    },
  });

  for (const event of events) {
    if (!event.entityId || out.has(event.entityId)) continue;
    const archived = event.action === "ANNOUNCEMENT_ARCHIVED";
    out.set(event.entityId, {
      archived,
      archivedAt: archived ? event.occurredAt : null,
      archiveReason: archived ? event.reason ?? null : null,
      archivedByUserId: archived ? event.actorUserId ?? null : null,
      lastTransitionAt: event.occurredAt,
    });
  }

  return out;
}

export async function announcementLifecycleState(
  client: AnnouncementReadClient,
  institutionId: string,
  announcementId: string
): Promise<AnnouncementLifecycleState> {
  const states = await announcementLifecycleStates(client, institutionId, [announcementId]);
  return states.get(announcementId) ?? { ...ACTIVE_STATE };
}

/**
 * Allocate an ordering timestamp only after the Announcement row mutex is held.
 * This avoids PostgreSQL transaction-start timestamps reordering waiters.
 */
export function nextAnnouncementTransitionAt(state: AnnouncementLifecycleState, now = new Date()): Date {
  const prior = state.lastTransitionAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return new Date(Math.max(now.getTime(), prior + 1));
}

/** Add lifecycle metadata without mutating the publication record. */
export async function decorateAnnouncementLifecycle<T extends { id: string }>(
  client: AnnouncementReadClient,
  institutionId: string,
  rows: T[]
): Promise<Array<T & AnnouncementLifecycleState>> {
  const states = await announcementLifecycleStates(client, institutionId, rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    ...(states.get(row.id) ?? { ...ACTIVE_STATE }),
  }));
}

/** Full immutable publication snapshot for audit provenance. */
export function announcementAuditSnapshot(row: AnnouncementLike) {
  return {
    id: row.id,
    institutionId: row.institutionId,
    title: row.title,
    message: row.message,
    type: row.type,
    priority: row.priority,
    target: row.target,
    publishAt: row.publishAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    pinned: row.pinned,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}
