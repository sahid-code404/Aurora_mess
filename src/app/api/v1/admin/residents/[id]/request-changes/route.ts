/**
 * POST /api/v1/admin/residents/[id]/request-changes { reason }
 * PENDING_APPROVAL | CHANGES_REQUESTED → CHANGES_REQUESTED. Status history,
 * audit (RESIDENT_CHANGES_REQUESTED) and notification carrying the reason.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { reasonSchema } from "@/lib/validation";
import { resolveNotificationsForEntity } from "@/lib/domain/notify";

const ALLOWED = ["PENDING_APPROVAL", "CHANGES_REQUESTED"];

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const body = await parseBody(ctx.req, z.object({ reason: reasonSchema }));

  const user = await db.user.findFirst({
    where: { id, institutionId: ctx.institutionId, role: "RESIDENT" },
  });
  if (!user) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }
  if (!ALLOWED.includes(user.status)) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `This resident is currently ${user.status.replace(/_/g, " ").toLowerCase()} and cannot be asked for changes.`,
      409
    );
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "CHANGES_REQUESTED" } });
    await tx.userStatusHistory.create({
      data: {
        userId: id,
        fromStatus: user.status,
        toStatus: "CHANGES_REQUESTED",
        changedByUserId: ctx.user.id,
        reason: body.reason,
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_CHANGES_REQUESTED",
        entityType: "USER",
        entityId: id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: user.status }),
        afterSummary: JSON.stringify({ status: "CHANGES_REQUESTED" }),
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
        type: "ACCOUNT_CHANGES_REQUESTED",
        title: "Changes requested on your application",
        message: `Your registration needs changes: ${body.reason}`,
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
      reason: `Changes requested on resident registration: ${body.reason}`,
      client: tx,
    });
  });

  try {
    await sweepOutbox();
  } catch {
    /* asynchronous */
  }

  return { data: { id, status: "CHANGES_REQUESTED" } };
});
