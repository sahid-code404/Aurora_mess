/**
 * NOTIFICATION queueing + best-effort delivery sweep.
 * appendOutbox stays in-transaction with the mutation (spec §73); the sweep
 * converts NOTIFICATION outbox rows into in-app notifications right after the
 * transaction commits — safe, idempotent (status-guarded), and cheap.
 */
import { db } from "@/lib/db";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { appendAudit } from "@/lib/audit";

export type NotifyInput = {
  userId: string;
  institutionId: string;
  type: string;
  title: string;
  message: string;
  entityRef?: string | null;
};

/** Queue a notification — pass the tx client to keep it atomic with the mutation. */
export async function queueNotification(
  input: NotifyInput,
  client?: unknown
): Promise<void> {
  await appendOutbox(
    input.institutionId,
    "NOTIFICATION",
    {
      userId: input.userId,
      institutionId: input.institutionId,
      type: input.type,
      title: input.title,
      message: input.message,
      entityRef: input.entityRef ?? null,
    },
    client as any
  );
}

export type AdminNotifyInput = {
  type: string;
  title: string;
  message: string;
  entityRef?: string | null;
};

/**
 * Queue a notification to all active administrators of an institution.
 * Pass the tx client if inside a transaction.
 */
export async function notifyAdmins(
  institutionId: string,
  input: AdminNotifyInput,
  client?: unknown
): Promise<void> {
  const prismaClient = (client as typeof db) ?? db;
  const admins = await prismaClient.user.findMany({
    where: {
      institutionId,
      role: "ADMIN",
      status: "ACTIVE",
    },
    select: { id: true },
  });

  for (const admin of admins) {
    await queueNotification(
      {
        userId: admin.id,
        institutionId,
        type: input.type,
        title: input.title,
        message: input.message,
        entityRef: input.entityRef ?? null,
      },
      client
    );
  }
}

/**
 * Options for resolving and vanishing previous notifications for an entity.
 */
export type ResolveNotificationOptions = {
  institutionId: string;
  entityRef: string;
  types?: string[];
  actorUserId?: string | null;
  actorRole?: string | null;
  reason: string;
  client?: unknown;
};

/**
 * Completes and vanishes prior notifications associated with an entity
 * (e.g. PAYMENT_SUBMITTED when payment is approved/rejected),
 * ensuring every vanished notification is permanently recorded in the AuditLog.
 */
export async function resolveNotificationsForEntity(
  options: ResolveNotificationOptions
): Promise<number> {
  const prismaClient = (options.client as typeof db) ?? db;

  const whereClause: {
    institutionId: string;
    entityRef: string;
    type?: { in: string[] };
  } = {
    institutionId: options.institutionId,
    entityRef: options.entityRef,
  };

  if (options.types && options.types.length > 0) {
    whereClause.type = { in: options.types };
  }

  const notifications = await prismaClient.notification.findMany({
    where: whereClause,
  });

  if (notifications.length === 0) return 0;

  for (const notif of notifications) {
    await appendAudit(
      {
        institutionId: options.institutionId,
        actorUserId: options.actorUserId ?? null,
        actorRole: options.actorRole ?? null,
        action: "NOTIFICATION_COMPLETED",
        entityType: "NOTIFICATION",
        entityId: notif.id,
        beforeSummary: `${notif.type}: ${notif.title}`,
        afterSummary: "VANISHED_AUDITED",
        reason: options.reason,
        metadata: {
          notificationId: notif.id,
          type: notif.type,
          title: notif.title,
          message: notif.message,
          entityRef: notif.entityRef,
          recipientUserId: notif.userId,
          completedAt: new Date().toISOString(),
          completionReason: options.reason,
        },
      },
      options.client
    );
  }

  await prismaClient.notification.deleteMany({
    where: {
      id: { in: notifications.map((n) => n.id) },
    },
  });

  return notifications.length;
}

/**
 * Completes and vanishes a single notification, creating a permanent audit event.
 */
export async function completeNotification(
  notificationId: string,
  actorUserId: string,
  actorRole: string,
  reason = "Acknowledged by user",
  client?: unknown
): Promise<boolean> {
  const prismaClient = (client as typeof db) ?? db;
  const notif = await prismaClient.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notif) return false;

  await appendAudit(
    {
      institutionId: notif.institutionId,
      actorUserId,
      actorRole,
      action: "NOTIFICATION_COMPLETED",
      entityType: "NOTIFICATION",
      entityId: notif.id,
      beforeSummary: `${notif.type}: ${notif.title}`,
      afterSummary: "VANISHED_AUDITED",
      reason,
      metadata: {
        notificationId: notif.id,
        type: notif.type,
        title: notif.title,
        message: notif.message,
        entityRef: notif.entityRef,
        recipientUserId: notif.userId,
        completedAt: new Date().toISOString(),
        completionReason: reason,
      },
    },
    client
  );

  await prismaClient.notification.delete({
    where: { id: notif.id },
  });

  return true;
}

/** Best-effort sweep after commit — never throws, never blocks correctness. */
export async function sweepOutboxSafe(limit = 100): Promise<void> {
  try {
    await sweepOutbox(limit);
  } catch {
    // delivery retries on the next mutation/sweep
  }
}

