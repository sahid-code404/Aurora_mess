/**
 * POST /api/v1/notifications/[id]/read — completes and vanishes the notification,
 * recording a permanent event in the AuditLog.
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";

export const POST = route({ auth: "ANY" }, async (ctx) => {
  const existing = await db.notification.findFirst({
    where: {
      id: ctx.params.id,
      userId: ctx.user.id,
      institutionId: ctx.institutionId,
    },
  });
  if (!existing) {
    throw new ApiError(CODES.NOT_FOUND, "Notification not found.", 404);
  }

  // Audit completion before vanishing
  await appendAudit({
    institutionId: ctx.institutionId,
    actorUserId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "NOTIFICATION_COMPLETED",
    entityType: "NOTIFICATION",
    entityId: existing.id,
    beforeSummary: `${existing.type}: ${existing.title}`,
    afterSummary: "VANISHED_AUDITED",
    reason: "Acknowledged and resolved by user",
    metadata: {
      notificationId: existing.id,
      type: existing.type,
      title: existing.title,
      message: existing.message,
      entityRef: existing.entityRef,
      recipientUserId: existing.userId,
      completedAt: new Date().toISOString(),
    },
  });

  await db.notification.delete({
    where: { id: existing.id },
  });

  return {
    data: {
      id: existing.id,
      vanished: true,
      audited: true,
      completedAt: new Date().toISOString(),
    },
  };
});
