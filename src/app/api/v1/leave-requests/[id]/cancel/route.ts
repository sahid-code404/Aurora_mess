/**
 * POST /api/v1/leave-requests/[id]/cancel — resident-owned lifecycle closure.
 *
 * Only PENDING requests can be cancelled. Approved/rejected leave is historical
 * review state and is never silently rewritten by this endpoint. Because a
 * pending leave has not changed ResidentMeal rows yet, cancellation is a pure
 * request-state transition: no meal re-evaluation is required.
 *
 * The updateMany(PENDING -> CANCELLED) guard makes an Admin-review vs Resident-
 * cancel race deterministic: exactly one transition wins and the loser gets a
 * 409 instead of overwriting the other decision.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { keyOfUtcDate, requireInstitutionContext } from "@/lib/domain/meal-engine";
import { notifyAdmins, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  const leave = await db.leaveRequest.findFirst({
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

  const result = await db.$transaction(async (tx) => {
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

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;
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
