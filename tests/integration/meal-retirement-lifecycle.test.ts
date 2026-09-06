import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { ensureInstancesForRange } from "@/lib/domain/meal-engine";
import {
  cancelMealDefinitionDeletion,
  refreshDueMealDefinitionRetirements,
  restoreMealDefinition,
  scheduleMealDefinitionDeletion,
} from "@/lib/domain/meal-retirement";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function fixture() {
  const institution = await db.institution.create({ data: { name: unique("Retirement Mess"), timezone: "UTC" } });
  const admin = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "ADMIN",
      status: "ACTIVE",
      email: `${unique("retirement-admin")}@example.test`,
      passwordHash: "integration-test-only",
    },
  });
  const definition = await db.mealDefinition.create({
    data: { institutionId: institution.id, name: unique("Retirement Meal") },
  });
  return { institution, admin, definition };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("meal-definition retirement lifecycle", () => {
  test("schedule archives immediately, cancellation preserves history, and explicit restore reactivates generation", async () => {
    const { institution, admin, definition } = await fixture();
    const scheduledAt = new Date("2026-09-01T00:00:00.000Z");

    const scheduled = await scheduleMealDefinitionDeletion({
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      actorUserId: admin.id,
      requestId: unique("schedule-request"),
      reason: "Retire this meal safely",
      now: scheduledAt,
    });
    expect(scheduled.request.status).toBe("SCHEDULED");
    expect(scheduled.request.scheduledFor?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(scheduled.definition.active).toBe(false);
    expect(scheduled.definition.archivedAt?.toISOString()).toBe(scheduledAt.toISOString());
    expect(scheduled.definition.deleteRequestedAt?.toISOString()).toBe(scheduledAt.toISOString());

    const whileArchived = await ensureInstancesForRange(institution.id, "UTC", "2099-01-10", "2099-01-10");
    expect(whileArchived).toBe(0);

    const cancelled = await cancelMealDefinitionDeletion({
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      actorUserId: admin.id,
      requestId: unique("cancel-request"),
      reason: "Meal is needed again",
      now: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(cancelled.request.status).toBe("CANCELLED");
    expect(cancelled.request.cancelReason).toBe("Meal is needed again");
    expect(cancelled.request.cancelledByUserId).toBe(admin.id);
    expect(cancelled.request.cancelledAt?.toISOString()).toBe("2026-09-02T00:00:00.000Z");
    expect(cancelled.definition.deleteRequestedAt).toBeNull();
    expect(cancelled.definition.archivedAt).not.toBeNull();
    expect(cancelled.definition.active).toBe(false);

    const restored = await restoreMealDefinition({
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      actorUserId: admin.id,
      requestId: unique("restore-request"),
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(restored.active).toBe(true);
    expect(restored.archivedAt).toBeNull();

    const afterRestore = await ensureInstancesForRange(institution.id, "UTC", "2099-01-10", "2099-01-10");
    expect(afterRestore).toBe(1);
  });

  test("due legacy queued deletion completes as a tombstone and cannot be restored", async () => {
    const { institution, admin, definition } = await fixture();
    const requestedAt = new Date("2026-07-01T00:00:00.000Z");
    const request = await db.deletionRequest.create({
      data: {
        institutionId: institution.id,
        entityType: "MEAL_DEFINITION",
        entityId: definition.id,
        requestedByUserId: admin.id,
        requestedAt,
        scheduledFor: new Date("2026-07-31T00:00:00.000Z"),
        reason: "Legacy queued request",
        status: "QUEUED",
      },
    });
    await db.mealDefinition.update({
      where: { id: definition.id },
      data: { deleteRequestedAt: requestedAt, active: true, archivedAt: null },
    });

    const sweep = await refreshDueMealDefinitionRetirements(
      institution.id,
      db,
      new Date("2026-08-05T00:00:00.000Z")
    );
    expect(sweep).toEqual({ completed: 1, blocked: 0 });

    const completed = await db.deletionRequest.findUniqueOrThrow({ where: { id: request.id } });
    const retired = await db.mealDefinition.findUniqueOrThrow({ where: { id: definition.id } });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt?.toISOString()).toBe("2026-08-05T00:00:00.000Z");
    expect(retired.active).toBe(false);
    expect(retired.archivedAt).not.toBeNull();
    expect(retired.deleteRequestedAt).not.toBeNull();

    let caught: unknown;
    try {
      await restoreMealDefinition({
        institutionId: institution.id,
        mealDefinitionId: definition.id,
        actorUserId: admin.id,
        requestId: unique("forbidden-restore"),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toContain("deletion request");
  });

  test("a due request whose referenced definition is missing is BLOCKED rather than falsely completed", async () => {
    const institution = await db.institution.create({ data: { name: unique("Blocked Retirement Mess") } });
    const request = await db.deletionRequest.create({
      data: {
        institutionId: institution.id,
        entityType: "MEAL_DEFINITION",
        entityId: unique("missing-definition"),
        requestedByUserId: unique("admin"),
        requestedAt: new Date("2026-01-01T00:00:00.000Z"),
        scheduledFor: new Date("2026-01-31T00:00:00.000Z"),
        reason: "Corrupted fixture",
        status: "SCHEDULED",
      },
    });

    const sweep = await refreshDueMealDefinitionRetirements(
      institution.id,
      db,
      new Date("2026-02-01T00:00:00.000Z")
    );
    expect(sweep).toEqual({ completed: 0, blocked: 1 });
    const blocked = await db.deletionRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.completedAt).toBeNull();
    expect(blocked.blockedReason).toContain("manual reconciliation");
  });
});
