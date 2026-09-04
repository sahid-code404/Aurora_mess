/**
 * POST /api/v1/admin/residents/[id]/deactivate { reason }
 * ACTIVE → INACTIVE. MANDATORY revocation of every session (spec §133),
 * status history, audit (RESIDENT_DEACTIVATED) and a notification with the
 * reason.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { revokeAllUserSessions } from "@/lib/auth/session";
import { reasonSchema } from "@/lib/validation";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const body = await parseBody(ctx.req, z.object({ reason: reasonSchema }));

  const user = await db.user.findFirst({
    where: { id, institutionId: ctx.institutionId, role: "RESIDENT" },
  });
  if (!user) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }
  if (user.status !== "ACTIVE") {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Only active residents can be deactivated (currently ${user.status
        .replace(/_/g, " ")
        .toLowerCase()}).`,
      409
    );
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "INACTIVE" } });
    await tx.userStatusHistory.create({
      data: {
        userId: id,
        fromStatus: "ACTIVE",
        toStatus: "INACTIVE",
        changedByUserId: ctx.user.id,
        reason: body.reason,
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_DEACTIVATED",
        entityType: "USER",
        entityId: id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: "ACTIVE" }),
        afterSummary: JSON.stringify({ status: "INACTIVE" }),
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
        type: "ACCOUNT_DEACTIVATED",
        title: "Account deactivated",
        message: `Your account has been deactivated. Reason: ${body.reason}`,
        entityRef: id,
      },
      tx
    );
  });

  // MANDATORY (spec §133): kill every live session immediately.
  await revokeAllUserSessions(id);
  try {
    await sweepOutbox();
  } catch {
    /* asynchronous */
  }

  return { data: { id, status: "INACTIVE" } };
});
