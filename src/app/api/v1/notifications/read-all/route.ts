/**
 * POST /api/v1/notifications/read-all — completes and vanishes all notifications
 * for the signed-in user, recording audit events for each one.
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { appendAudit } from "@/lib/audit";

export const POST = route({ auth: "ANY" }, async (ctx) => {
  const existingList = await db.notification.findMany({
    where: {
      userId: ctx.user.id,
      institutionId: ctx.institutionId,
    },
  });

  for (const notif of existingList) {
    await appendAudit({
      institutionId: ctx.institutionId,
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role,
      action: "NOTIFICATION_COMPLETED",
      entityType: "NOTIFICATION",
      entityId: notif.id,
      beforeSummary: `${notif.type}: ${notif.title}`,
      afterSummary: "VANISHED_AUDITED",
      reason: "Batch cleared and resolved by user",
      metadata: {
        notificationId: notif.id,
        type: notif.type,
        title: notif.title,
        message: notif.message,
        entityRef: notif.entityRef,
        recipientUserId: notif.userId,
        completedAt: new Date().toISOString(),
      },
    });
  }

  const result = await db.notification.deleteMany({
    where: {
      userId: ctx.user.id,
      institutionId: ctx.institutionId,
    },
  });

  return { data: { updated: result.count, vanished: true }, meta: { unreadCount: 0 } };
});
