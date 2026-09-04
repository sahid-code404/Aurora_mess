/**
 * DELETE & PATCH /api/v1/admin/announcements/[id]
 * Delete or archive announcements with audit logging.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";

const patchSchema = z.object({
  action: z.enum(["ARCHIVE", "UNARCHIVE", "TOGGLE_PIN", "REPUBLISH"]).optional(),
  title: z.string().trim().min(3).max(140).optional(),
  message: z.string().trim().min(3).max(2000).optional(),
  type: z.enum(["INFO", "ALERT", "WARNING", "MAINTENANCE", "EVENT"]).optional(),
  priority: z.enum(["NORMAL", "HIGH", "URGENT", "CRITICAL"]).optional(),
  target: z.enum(["EVERYONE", "RESIDENTS", "ADMINS"]).optional(),
  publishAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  pinned: z.boolean().optional(),
});

export const DELETE = route({ auth: "ADMIN" }, async (ctx) => {
  const { id } = ctx.params;

  const announcement = await db.announcement.findFirst({
    where: { id, institutionId: ctx.institutionId },
  });
  if (!announcement) {
    throw new ApiError(CODES.NOT_FOUND, "Announcement not found.", 404);
  }

  await db.announcement.delete({
    where: { id: announcement.id },
  });

  await appendAudit({
    institutionId: ctx.institutionId,
    actorUserId: ctx.user.id,
    actorRole: "ADMIN",
    action: "ANNOUNCEMENT_DELETED",
    entityType: "ANNOUNCEMENT",
    entityId: announcement.id,
    requestId: ctx.requestId,
    beforeSummary: JSON.stringify({
      title: announcement.title,
      type: announcement.type,
      priority: announcement.priority,
    }),
  });

  return { data: { success: true, message: "Announcement deleted." } };
});

export const PATCH = route({ auth: "ADMIN" }, async (ctx) => {
  const { id } = ctx.params;
  const body = await parseBody(ctx.req, patchSchema);

  const announcement = await db.announcement.findFirst({
    where: { id, institutionId: ctx.institutionId },
  });
  if (!announcement) {
    throw new ApiError(CODES.NOT_FOUND, "Announcement not found.", 404);
  }

  let updatedData: {
    title?: string;
    message?: string;
    type?: "INFO" | "ALERT" | "WARNING" | "MAINTENANCE" | "EVENT";
    priority?: "NORMAL" | "HIGH" | "URGENT" | "CRITICAL";
    target?: "EVERYONE" | "RESIDENTS" | "ADMINS";
    publishAt?: Date;
    expiresAt?: Date | null;
    pinned?: boolean;
  } = {};
  let auditAction = "ANNOUNCEMENT_UPDATED";

  if (body.action === "ARCHIVE") {
    updatedData = { expiresAt: new Date(), pinned: false };
    auditAction = "ANNOUNCEMENT_ARCHIVED";
  } else if (body.action === "UNARCHIVE") {
    updatedData = { expiresAt: null };
    auditAction = "ANNOUNCEMENT_UNARCHIVED";
  } else if (body.action === "TOGGLE_PIN") {
    updatedData = { pinned: !announcement.pinned };
    auditAction = "ANNOUNCEMENT_PIN_TOGGLED";
  } else {
    if (body.title !== undefined) updatedData.title = body.title;
    if (body.message !== undefined) updatedData.message = body.message;
    if (body.type !== undefined) updatedData.type = body.type;
    if (body.priority !== undefined) updatedData.priority = body.priority;
    if (body.target !== undefined) updatedData.target = body.target;
    if (body.pinned !== undefined) updatedData.pinned = body.pinned;

    if (body.action === "REPUBLISH") {
      const now = new Date();
      if (body.publishAt) {
        const pDate = new Date(body.publishAt);
        updatedData.publishAt = pDate > now ? pDate : now;
      } else {
        updatedData.publishAt = now;
      }

      if (body.expiresAt !== undefined) {
        let exp = body.expiresAt ? new Date(body.expiresAt) : null;
        if (exp && exp <= updatedData.publishAt) {
          exp = null;
        }
        updatedData.expiresAt = exp;
      } else if (announcement.expiresAt && announcement.expiresAt <= now) {
        const prevDurationMs = announcement.expiresAt.getTime() - announcement.publishAt.getTime();
        updatedData.expiresAt = prevDurationMs > 0 ? new Date(now.getTime() + prevDurationMs) : null;
      }
      auditAction = "ANNOUNCEMENT_REPUBLISHED";
    } else {
      if (body.publishAt !== undefined) updatedData.publishAt = body.publishAt ? new Date(body.publishAt) : new Date();
      if (body.expiresAt !== undefined) updatedData.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    }
  }

  const updated = await db.announcement.update({
    where: { id: announcement.id },
    data: updatedData,
  });

  await appendAudit({
    institutionId: ctx.institutionId,
    actorUserId: ctx.user.id,
    actorRole: "ADMIN",
    action: auditAction,
    entityType: "ANNOUNCEMENT",
    entityId: announcement.id,
    requestId: ctx.requestId,
    beforeSummary: JSON.stringify({ expiresAt: announcement.expiresAt, pinned: announcement.pinned }),
    afterSummary: JSON.stringify({ expiresAt: updated.expiresAt, pinned: updated.pinned }),
  });

  return { data: updated, success: true, message: "Announcement updated." };
});
