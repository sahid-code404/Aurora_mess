/**
 * POST /api/v1/admin/residents/[id]/activate — reactivate a resident.
 * INACTIVE → ACTIVE. Status history + audit (RESIDENT_ACTIVATED).
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const user = await db.user.findFirst({
    where: { id, institutionId: ctx.institutionId, role: "RESIDENT" },
  });
  if (!user) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }
  if (user.status !== "INACTIVE") {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Only inactive residents can be reactivated (currently ${user.status
        .replace(/_/g, " ")
        .toLowerCase()}).`,
      409
    );
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "ACTIVE" } });
    await tx.userStatusHistory.create({
      data: {
        userId: id,
        fromStatus: "INACTIVE",
        toStatus: "ACTIVE",
        changedByUserId: ctx.user.id,
        reason: "Reactivated by administration",
      },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_ACTIVATED",
        entityType: "USER",
        entityId: id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ status: "INACTIVE" }),
        afterSummary: JSON.stringify({ status: "ACTIVE" }),
        ip: ctx.req.headers.get("x-forwarded-for") ?? null,
        userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
      },
      tx
    );
  });

  return { data: { id, status: "ACTIVE" } };
});
