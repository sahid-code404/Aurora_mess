import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { ApiError, CODES } from "@/lib/errors";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";
import { lockActiveResidentForMealMutation } from "@/lib/domain/resident-meal-mutation";

const prefix = "phase55-meal-mutation-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const institution = await db.institution.create({ data: { name: unique("institution"), timezone: "Asia/Kolkata" } });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase55-resident.test`,
      passwordHash: "phase55-test-only",
    },
  });
  const definition = await db.mealDefinition.create({
    data: {
      institutionId: institution.id,
      name: unique("meal"),
      serviceStartLocal: "12:00",
      serviceEndLocal: "13:00",
      cutoffLocalTime: "10:00",
    },
  });
  const version = await db.mealDefinitionVersion.create({
    data: { mealDefinitionId: definition.id, version: 1, configSnapshotJson: "{}" },
  });
  const now = new Date();
  const instance = await db.mealInstance.create({
    data: {
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      mealDefinitionVersionId: version.id,
      serviceDate: new Date(Date.UTC(2035, 0, 1)),
      serviceStartAt: new Date(now.getTime() + 3_600_000),
      serviceEndAt: new Date(now.getTime() + 7_200_000),
      cutoffAt: new Date(now.getTime() + 1_800_000),
      lockAt: new Date(now.getTime() + 1_800_000),
      status: "OPEN",
    },
  });
  return { institution, resident, definition, instance };
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    await db.auditEvent.deleteMany({ where: { institutionId: { in: ids } } });
    await db.outboxEvent.deleteMany({ where: { institutionId: { in: ids } } });
    await db.guestMealRequest.deleteMany({ where: { institutionId: { in: ids } } });
    await db.residentMeal.deleteMany({ where: { institutionId: { in: ids } } });
    await db.mealInstance.deleteMany({ where: { institutionId: { in: ids } } });
    const definitions = await db.mealDefinition.findMany({ where: { institutionId: { in: ids } }, select: { id: true } });
    const definitionIds = definitions.map((row) => row.id);
    if (definitionIds.length > 0) {
      await db.mealDefinitionVersion.deleteMany({ where: { mealDefinitionId: { in: definitionIds } } });
      await db.mealDefinition.deleteMany({ where: { id: { in: definitionIds } } });
    }
    const users = await db.user.findMany({ where: { institutionId: { in: ids } }, select: { id: true } });
    const userIds = users.map((row) => row.id);
    if (userIds.length > 0) {
      await db.userStatusHistory.deleteMany({ where: { userId: { in: userIds } } });
      await db.session.deleteMany({ where: { userId: { in: userIds } } });
      await db.userProfile.deleteMany({ where: { userId: { in: userIds } } });
    }
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("resident meal mutation serialization", () => {
  test("access removal winning the Resident mutex makes a billable meal mutation re-read INACTIVE and fail", async () => {
    const { institution, resident } = await fixture();
    const lifecycleLocked = deferred();
    const releaseLifecycle = deferred();
    let mutationLocked = false;

    const lifecycle = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      await tx.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });
      lifecycleLocked.resolve();
      await releaseLifecycle.promise;
    });

    await lifecycleLocked.promise;

    const mutationSettled = db
      .$transaction(async (tx) => {
        const authoritative = await lockActiveResidentForMealMutation(tx, institution.id, resident.id);
        mutationLocked = true;
        return authoritative.id;
      })
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationLocked).toBe(false);

    releaseLifecycle.resolve();
    await lifecycle;
    const outcome = await mutationSettled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
  });

  test("meal mutation winning the Resident mutex commits before a concurrent deactivation can proceed", async () => {
    const { institution, resident, instance } = await fixture();
    const mutationLocked = deferred();
    const releaseMutation = deferred();
    let lifecycleLocked = false;

    const mutation = db.$transaction(async (tx) => {
      await lockActiveResidentForMealMutation(tx, institution.id, resident.id);
      const guest = await tx.guestMealRequest.create({
        data: {
          institutionId: institution.id,
          hostResidentId: resident.id,
          mealInstanceId: instance.id,
          quantity: 1,
          unitPriceMinor: 5000,
          totalPriceMinor: 5000,
          status: "CONFIRMED",
        },
      });
      mutationLocked.resolve();
      await releaseMutation.promise;
      return guest.id;
    });

    await mutationLocked.promise;

    const lifecycle = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      lifecycleLocked = true;
      await tx.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lifecycleLocked).toBe(false);

    releaseMutation.resolve();
    const guestId = await mutation;
    await lifecycle;

    expect((await db.guestMealRequest.findUniqueOrThrow({ where: { id: guestId } })).status).toBe("CONFIRMED");
    expect((await db.user.findUniqueOrThrow({ where: { id: resident.id } })).status).toBe("INACTIVE");
  });

  test("serialized status-qualified guest cancellation yields one terminal transition and one audit", async () => {
    const { institution, resident, instance } = await fixture();
    const guest = await db.guestMealRequest.create({
      data: {
        institutionId: institution.id,
        hostResidentId: resident.id,
        mealInstanceId: instance.id,
        quantity: 2,
        unitPriceMinor: 5000,
        totalPriceMinor: 10000,
        status: "CONFIRMED",
      },
    });

    async function cancel(requestId: string) {
      return db.$transaction(async (tx) => {
        await lockActiveResidentForMealMutation(tx, institution.id, resident.id);
        const current = await tx.guestMealRequest.findUniqueOrThrow({ where: { id: guest.id } });
        if (current.status === "CANCELLED") {
          throw new ApiError(CODES.VALIDATION_FAILED, "already cancelled", 409);
        }
        const guard = await tx.guestMealRequest.updateMany({
          where: { id: current.id, status: current.status },
          data: { status: "CANCELLED", lockedAt: new Date() },
        });
        if (guard.count !== 1) throw new ApiError(CODES.RESOURCE_CHANGED, "changed", 409);
        await appendAudit(
          {
            institutionId: institution.id,
            actorUserId: resident.id,
            actorRole: "RESIDENT",
            action: "GUEST_MEAL_CANCELLED",
            entityType: "GUEST_MEAL_REQUEST",
            entityId: guest.id,
            requestId,
            beforeSummary: JSON.stringify({ status: current.status }),
            afterSummary: JSON.stringify({ status: "CANCELLED" }),
          },
          tx
        );
      });
    }

    const outcomes = await Promise.allSettled([cancel(unique("cancel-a")), cancel(unique("cancel-b"))]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await db.guestMealRequest.findUniqueOrThrow({ where: { id: guest.id } })).status).toBe("CANCELLED");
    expect(
      await db.auditEvent.count({
        where: { institutionId: institution.id, entityType: "GUEST_MEAL_REQUEST", entityId: guest.id, action: "GUEST_MEAL_CANCELLED" },
      })
    ).toBe(1);
  });
});
