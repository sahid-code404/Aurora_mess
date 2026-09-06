/**
 * POST /api/v1/admin/residents/[id]/approve — approve a registration.
 * PENDING_APPROVAL | CHANGES_REQUESTED → ACTIVE. Sets membershipEffectiveFrom
 * to now when still null (mid-month join handling). Status history row, audit
 * (RESIDENT_APPROVED) and outbox notification, all in one serialized transaction.
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { resolveNotificationsForEntity } from "@/lib/domain/notify";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

const ALLOWED = ["PENDING_APPROVAL", "CHANGES_REQUESTED"];

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;

  const result = await db.$transaction(async (tx) => {
    await lockResidentLifecycleMutation(tx, ctx.institutionId, id);
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) {
      throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
    }
    if (!ALLOWED.includes(user.status)) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `This resident is currently ${user.status.replace(/_/g, " ").toLowerCase()} and cannot be approved.`,
        409
      );
    }

    const now = new Date();
    const effectiveFrom = user.membershipEffectiveFrom ?? now;

    await tx.user.update({
      where: { id },
      data: {
        status: "ACTIVE",
        ...(user.membershipEffectiveFrom ? {} : { membershipEffectiveFrom: now }),
      },
    });
    await tx.userStatusHistory.create({
      data: {
        userId: id,
        fromStatus: user.status,
        toStatus: "ACTIVE",
        changedByUserId: ctx.user.id,
        reason: "Approved by administration",
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_APPROVED",
        entityType: "USER",
        entityId: id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ status: user.status }),
        afterSummary: JSON.stringify({
          status: "ACTIVE",
          membershipEffectiveFrom: effectiveFrom,
        }),
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
        type: "ACCOUNT_APPROVED",
        title: "Account approved",
        message: "Your account has been approved. Welcome aboard!",
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
      reason: "Resident registration approved by admin",
      client: tx,
    });

    return { effectiveFrom };
  });

  try {
    await sweepOutbox();
  } catch {
    /* notification delivery is asynchronous — never block the response */
  }

  return { data: { id, status: "ACTIVE", membershipEffectiveFrom: result.effectiveFrom } };
});
