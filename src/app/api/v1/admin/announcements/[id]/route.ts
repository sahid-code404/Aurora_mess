/**
 * DELETE & PATCH /api/v1/admin/announcements/[id]
 * Announcement mutations are serialized on the Announcement row and audited in
 * the same transaction. DELETE is retained only as a compatibility alias for a
 * non-destructive archive; published announcement rows are never hard-deleted.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import {
  announcementAuditSnapshot,
  announcementLifecycleState,
  lockAnnouncementMutation,
  nextAnnouncementTransitionAt,
  requireAnnouncementAfterLock,
} from "@/lib/domain/announcement-lifecycle";

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
  reason: z.string().trim().min(3).max(500).optional(),
});

function validatePublicationWindow(publishAt: Date, expiresAt: Date | null): void {
  if (expiresAt && expiresAt <= publishAt) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Expiry must come after publishing.", 400, {
      expiresAt: "Expiry must be after the publish date.",
    });
  }
}

export const DELETE = route({ auth: "ADMIN" }, async (ctx) => {
  const { id } = ctx.params;

  const result = await db.$transaction(async (tx) => {
    await lockAnnouncementMutation(tx, ctx.institutionId, id);
    const announcement = await requireAnnouncementAfterLock(tx, ctx.institutionId, id);
    const lifecycle = await announcementLifecycleState(tx, ctx.institutionId, id);

    if (lifecycle.archived) {
      return { announcement, lifecycle };
    }

    const occurredAt = nextAnnouncementTransitionAt(lifecycle);
    const reason = "Archived through the legacy delete action; publication history retained.";
    const snapshot = announcementAuditSnapshot(announcement);
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "ANNOUNCEMENT_ARCHIVED",
        entityType: "ANNOUNCEMENT",
        entityId: announcement.id,
        requestId: ctx.requestId,
        occurredAt,
        reason,
        beforeSummary: JSON.stringify({ ...snapshot, lifecycle: { archived: false } }),
        afterSummary: JSON.stringify({ ...snapshot, lifecycle: { archived: true, archivedAt: occurredAt.toISOString() } }),
        metadata: { compatibilityDelete: true },
      },
      tx
    );

    return {
      announcement,
      lifecycle: {
        archived: true,
        archivedAt: occurredAt,
        archiveReason: reason,
        archivedByUserId: ctx.user.id,
        lastTransitionAt: occurredAt,
      },
    };
  });

  return {
    data: {
      ...result.announcement,
      ...result.lifecycle,
      archived: true,
      hardDeleted: false,
    },
    success: true,
    message: "Announcement archived. Publication history was retained.",
  };
});

export const PATCH = route({ auth: "ADMIN" }, async (ctx) => {
  const { id } = ctx.params;
  const body = await parseBody(ctx.req, patchSchema);

  const result = await db.$transaction(async (tx) => {
    await lockAnnouncementMutation(tx, ctx.institutionId, id);
    const announcement = await requireAnnouncementAfterLock(tx, ctx.institutionId, id);
    const lifecycle = await announcementLifecycleState(tx, ctx.institutionId, id);
    const before = announcementAuditSnapshot(announcement);

    if (body.action === "ARCHIVE") {
      if (lifecycle.archived) {
        throw new ApiError(CODES.RESOURCE_CHANGED, "This announcement is already archived.", 409);
      }
      if (!body.reason) {
        throw new ApiError(CODES.VALIDATION_FAILED, "Please provide a reason for archiving this announcement.", 422, {
          reason: "Archive reason is required.",
        });
      }

      const occurredAt = nextAnnouncementTransitionAt(lifecycle);
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: ctx.user.id,
          actorRole: "ADMIN",
          action: "ANNOUNCEMENT_ARCHIVED",
          entityType: "ANNOUNCEMENT",
          entityId: announcement.id,
          requestId: ctx.requestId,
          occurredAt,
          reason: body.reason,
          beforeSummary: JSON.stringify({ ...before, lifecycle: { archived: false } }),
          afterSummary: JSON.stringify({ ...before, lifecycle: { archived: true, archivedAt: occurredAt.toISOString() } }),
        },
        tx
      );

      return {
        row: announcement,
        lifecycle: {
          archived: true,
          archivedAt: occurredAt,
          archiveReason: body.reason,
          archivedByUserId: ctx.user.id,
          lastTransitionAt: occurredAt,
        },
        message: "Announcement archived.",
      };
    }

    if (body.action === "UNARCHIVE") {
      if (!lifecycle.archived) {
        throw new ApiError(CODES.RESOURCE_CHANGED, "This announcement is not archived.", 409);
      }
      if (announcement.expiresAt && announcement.expiresAt <= new Date()) {
        throw new ApiError(
          CODES.VALIDATION_FAILED,
          "This announcement has already expired. Republish it with a new publication window instead.",
          409
        );
      }

      const occurredAt = nextAnnouncementTransitionAt(lifecycle);
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: ctx.user.id,
          actorRole: "ADMIN",
          action: "ANNOUNCEMENT_UNARCHIVED",
          entityType: "ANNOUNCEMENT",
          entityId: announcement.id,
          requestId: ctx.requestId,
          occurredAt,
          reason: body.reason ?? null,
          beforeSummary: JSON.stringify({ ...before, lifecycle: { archived: true, archivedAt: lifecycle.archivedAt?.toISOString() ?? null } }),
          afterSummary: JSON.stringify({ ...before, lifecycle: { archived: false } }),
        },
        tx
      );

      return {
        row: announcement,
        lifecycle: {
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archivedByUserId: null,
          lastTransitionAt: occurredAt,
        },
        message: "Announcement restored.",
      };
    }

    if (lifecycle.archived && body.action !== "REPUBLISH") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Archived announcements are immutable. Restore or republish this announcement before editing it.",
        409
      );
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

    if (body.action === "TOGGLE_PIN") {
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
        const requestedPublishAt = body.publishAt ? new Date(body.publishAt) : now;
        updatedData.publishAt = requestedPublishAt > now ? requestedPublishAt : now;

        if (body.expiresAt !== undefined) {
          updatedData.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
        } else if (announcement.expiresAt && announcement.expiresAt <= now) {
          const previousDurationMs = announcement.expiresAt.getTime() - announcement.publishAt.getTime();
          updatedData.expiresAt = previousDurationMs > 0
            ? new Date(updatedData.publishAt.getTime() + previousDurationMs)
            : null;
        }
        auditAction = "ANNOUNCEMENT_REPUBLISHED";
      } else {
        if (body.publishAt !== undefined) updatedData.publishAt = body.publishAt ? new Date(body.publishAt) : new Date();
        if (body.expiresAt !== undefined) updatedData.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      }
    }

    const effectivePublishAt = updatedData.publishAt ?? announcement.publishAt;
    const effectiveExpiresAt = Object.prototype.hasOwnProperty.call(updatedData, "expiresAt")
      ? updatedData.expiresAt ?? null
      : announcement.expiresAt;
    validatePublicationWindow(effectivePublishAt, effectiveExpiresAt);

    const updated = await tx.announcement.update({
      where: { id: announcement.id },
      data: updatedData,
    });
    const after = announcementAuditSnapshot(updated);
    const isLifecycleTransition = auditAction === "ANNOUNCEMENT_REPUBLISHED";
    const occurredAt = isLifecycleTransition ? nextAnnouncementTransitionAt(lifecycle) : undefined;

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: auditAction,
        entityType: "ANNOUNCEMENT",
        entityId: announcement.id,
        requestId: ctx.requestId,
        occurredAt,
        reason: body.reason ?? null,
        beforeSummary: JSON.stringify({ ...before, lifecycle: { archived: lifecycle.archived } }),
        afterSummary: JSON.stringify({ ...after, lifecycle: { archived: false } }),
      },
      tx
    );

    return {
      row: updated,
      lifecycle: {
        archived: false,
        archivedAt: null,
        archiveReason: null,
        archivedByUserId: null,
        lastTransitionAt: occurredAt ?? lifecycle.lastTransitionAt,
      },
      message: auditAction === "ANNOUNCEMENT_REPUBLISHED" ? "Announcement republished." : "Announcement updated.",
    };
  });

  return {
    data: { ...result.row, ...result.lifecycle },
    success: true,
    message: result.message,
  };
});
