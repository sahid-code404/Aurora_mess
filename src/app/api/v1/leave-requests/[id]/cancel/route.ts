/**
 * POST /api/v1/leave-requests/[id]/cancel — resident-owned lifecycle closure.
 *
 * Only an ACTIVE owning Resident may cancel a PENDING request. The Resident User
 * row is locked before account/leave reads so Admin access removal, Admin review
 * and Resident cancellation observe authoritative committed state. The PENDING
 * status-qualified write remains the final review-vs-cancel race guard.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { notifyAdmins, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";
import {
  lockResidentLifecycleMutation,
  requireActiveResidentAfterLock,
} from "@/lib/domain/resident-lifecycle";

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const result = await db.$transaction(async (tx) => {
    await lockResidentLifecycleMutation(tx, ctx.institutionId, ctx.user.id);
    const resident = await requireActiveResidentAfterLock(tx, ctx.institutionId, ctx.user.id);

    const leave = await tx.leaveRequest.findFirst({
      where: {
        id: ctx.params.id,
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
      },
      include: {
        selectedMeals: {
          include: { mealDefinition: { select: { id: true, name: true } } },
        },
      },
    });

    if (!leave) {
      throw new ApiError(CODES.NOT_FOUND, "This leave request could not be found.", 404);
    }
    if (leave.status === "CANCELLED") {
      throw new ApiError(CODES.VALIDATION_FAILED, "This leave request is already cancelled.", 409);
    }
    if (leave.status !== "PENDING") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Only pending leave requests can be cancelled. Reviewed leave remains in history.",
        409
      );
    }

    const guard = await tx.leaveRequest.updateMany({
      where: {
        id: leave.id,
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        status: "PENDING",
      },
      data: { status: "CANCELLED" },
    });

    if (guard.count !== 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This leave request was reviewed or changed just now. Refresh to see its latest state.",
        409
      );
    }

    const selectedMealIds = leave.selectedMeals.map((row) => row.mealDefinitionId);
    const selectedMealNames = leave.selectedMeals.map((row) => row.mealDefinition.name);
    const startDate = keyOfUtcDate(leave.startDate);
    const endDate = keyOfUtcDate(leave.endDate);

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "LEAVE_CANCELLED",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({
          status: "PENDING",
          startDate,
          endDate,
          mealScope: leave.mealScope,
          mealDefinitionIds: selectedMealIds,
        }),
        afterSummary: JSON.stringify({ status: "CANCELLED" }),
        metadata: {
          startDate,
          endDate,
          mealScope: leave.mealScope,
          mealDefinitionIds: selectedMealIds,
          selectedMealNames,
          selfService: true,
        },
      },
      tx
    );

    const residentName = resident.profile?.fullName || ctx.user.email;
    const scopeLabel =
      leave.mealScope === "SELECTED_MEALS" && selectedMealNames.length > 0
        ? ` for ${selectedMealNames.join(", ")}`
        : "";

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "LEAVE_CANCELLED",
        title: "Leave request cancelled",
        message: `${residentName} cancelled leave from ${startDate} to ${endDate}${scopeLabel}.`,
        entityRef: leave.id,
      },
      tx
    );

    await resolveNotificationsForEntity({
      institutionId: ctx.institutionId,
      entityRef: leave.id,
      types: ["LEAVE_REQUESTED"],
      actorUserId: ctx.user.id,
      actorRole: "RESIDENT",
      reason: "Pending leave request cancelled by resident",
      client: tx,
    });

    return {
      id: leave.id,
      status: "CANCELLED" as const,
      startDate,
      endDate,
      mealScope: leave.mealScope,
      selectedMeals: leave.selectedMeals.map((row) => ({
        id: row.mealDefinition.id,
        name: row.mealDefinition.name,
      })),
    };
  });

  await sweepOutboxSafe();
  return { data: result };
});
