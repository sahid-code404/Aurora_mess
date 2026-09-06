/**
 * POST /api/v1/admin/residents/[id]/reject { reason }
 * PENDING_APPROVAL | CHANGES_REQUESTED → REJECTED. Revokes all sessions,
 * records status history, audit (RESIDENT_REJECTED) and a notification with
 * the reason — all committed atomically except the (idempotent) revocation.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { revokeAllUserSessions } from "@/lib/auth/session";
import { reasonSchema } from "@/lib/validation";
import { resolveNotificationsForEntity } from "@/lib/domain/notify";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

const ALLOWED = ["PENDING_APPROVAL", "CHANGES_REQUESTED"];

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const body = await parseBody(ctx.req, z.object({ reason: reasonSchema }));

  await db.$transaction(async (tx) => {
    await lockResidentLifecycleMutation(tx, ctx.institutionId, id);
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) {
      throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
    }
    if (!ALLOWED.includes(user.status)) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `This resident is currently ${user.status.replace(/_/g, " ").toLowerCase()} and cannot be rejected.`,
        409
      );
    }

    await tx.user.update({ where: { id }, data: { status: "REJECTED" } });
    await tx.userStatusHistory.create({
      data: {
        userId: id,
        fromStatus: user.status,
        toStatus: "REJECTED",
        changedByUserId: ctx.user.id,
        reason: body.reason,
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_REJECTED",
        entityType: "USER",
        entityId: id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: user.status }),
        afterSummary: JSON.stringify({ status: "REJECTED" }),
        ip: ctx.req.headers.get("x-forwarded-for") ?? null,
        userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
      },
      tx
    );
    await appendOutbox(
      ctx.institutionId,
      "NOTIFICATION",
      {
        userId: id,
        institutionId: ctx.institutionId,
        type: "ACCOUNT_REJECTED",
        title: "Registration declined",
        message: `Your registration was declined. Reason: ${body.reason}`,
        entityRef: id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: id,
      types: ["RESIDENT_REGISTERED"],
      actorUserId: ctx.user.id,
      actorRole: "ADMIN",
      reason: `Resident registration declined by admin: ${body.reason}`,
      client: tx,
    });
  });

  // Defense in depth: sessions also die via the ACTIVE check in getSessionUser.
  await revokeAllUserSessions(id);
  try {
    await sweepOutbox();
  } catch {
    /* asynchronous */
  }

  return { data: { id, status: "REJECTED" } };
});
