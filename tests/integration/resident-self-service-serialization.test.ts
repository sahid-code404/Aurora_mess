import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";
import {
  lockResidentLifecycleMutation,
  requireActiveResidentAfterLock,
} from "@/lib/domain/resident-lifecycle";
import { lockActiveResidentForMealMutation } from "@/lib/domain/resident-meal-mutation";

const prefix = "phase57-self-service-";

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

async function residentFixture() {
  const institution = await db.institution.create({
    data: { name: unique("institution"), timezone: "UTC", settings: { create: {} } },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase57-resident.test`,
      passwordHash: "phase57-test-only",
    },
  });
  return { institution, resident };
}

async function guestFixture() {
  const { institution, resident } = await residentFixture();
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
      serviceStartAt: new Date(now.getTime() + 2 * 60 * 60_000),
      serviceEndAt: new Date(now.getTime() + 3 * 60 * 60_000),
      cutoffAt: new Date(now.getTime() + 60 * 60_000),
      lockAt: new Date(now.getTime() + 60 * 60_000),
      status: "OPEN",
    },
  });
  const guest = await db.guestMealRequest.create({
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
  return { institution, resident, definition, guest };
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
    await db.leaveRequestMeal.deleteMany({ where: { leaveRequest: { institutionId: { in: ids } } } });
    await db.leaveRequest.deleteMany({ where: { institutionId: { in: ids } } });
    await db.guestMealRequest.deleteMany({ where: { institutionId: { in: ids } } });
    await db.residentMeal.deleteMany({ where: { institutionId: { in: ids } } });
    await db.mealInstance.deleteMany({ where: { institutionId: { in: ids } } });
    const definitions = await db.mealDefinition.findMany({
      where: { institutionId: { in: ids } },
      select: { id: true },
    });
    const definitionIds = definitions.map((row) => row.id);
    if (definitionIds.length > 0) {
      await db.mealDefinitionVersion.deleteMany({ where: { mealDefinitionId: { in: definitionIds } } });
      await db.mealDefinition.deleteMany({ where: { id: { in: definitionIds } } });
    }
    await db.paymentStatusHistory.deleteMany({ where: { payment: { institutionId: { in: ids } } } });
    await db.payment.deleteMany({ where: { institutionId: { in: ids } } });
    const users = await db.user.findMany({ where: { institutionId: { in: ids } }, select: { id: true } });
    const userIds = users.map((row) => row.id);
    if (userIds.length > 0) {
      await db.userStatusHistory.deleteMany({ where: { userId: { in: userIds } } });
      await db.session.deleteMany({ where: { userId: { in: userIds } } });
    }
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("resident self-service serialization", () => {
  test("deactivation winning the User mutex makes a later financial self-service ACTIVE assertion fail", async () => {
    const { institution, resident } = await residentFixture();
    const lifecycleLocked = deferred();
    const releaseLifecycle = deferred();
    let financialPassed = false;

    const lifecycle = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      await tx.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });
      lifecycleLocked.resolve();
      await releaseLifecycle.promise;
    });

    await lifecycleLocked.promise;

    const financial = db
      .$transaction(async (tx) => {
        await lockResidentFinancialMutation(tx, institution.id, resident.id);
        await requireActiveResidentAfterLock(tx, institution.id, resident.id);
        financialPassed = true;
      })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(financialPassed).toBe(false);

    releaseLifecycle.resolve();
    await lifecycle;
    const result = await financial;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
  });

  test("guest quantity adjustments sharing one expected quantity serialize and only the first can commit", async () => {
    const { institution, resident, guest } = await guestFixture();
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondRead = false;

    const first = db.$transaction(async (tx) => {
      await lockActiveResidentForMealMutation(tx, institution.id, resident.id);
      const current = await tx.guestMealRequest.findUniqueOrThrow({ where: { id: guest.id } });
      expect(current.quantity).toBe(1);
      firstLocked.resolve();
      await releaseFirst.promise;
      const guard = await tx.guestMealRequest.updateMany({
        where: { id: guest.id, status: current.status, quantity: 1 },
        data: { quantity: 2, totalPriceMinor: current.unitPriceMinor * 2 },
      });
      expect(guard.count).toBe(1);
    });

    await firstLocked.promise;

    const second = db
      .$transaction(async (tx) => {
        await lockActiveResidentForMealMutation(tx, institution.id, resident.id);
        const current = await tx.guestMealRequest.findUniqueOrThrow({ where: { id: guest.id } });
        secondRead = true;
        if (current.quantity !== 1) {
          throw new ApiError(CODES.RESOURCE_CHANGED, "changed", 409);
        }
        await tx.guestMealRequest.updateMany({
          where: { id: guest.id, status: current.status, quantity: 1 },
          data: { quantity: 3, totalPriceMinor: current.unitPriceMinor * 3 },
        });
      })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondRead).toBe(false);

    releaseFirst.resolve();
    await first;
    const secondResult = await second;
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) expect(secondResult.error).toMatchObject({ code: CODES.RESOURCE_CHANGED, status: 409 });

    const final = await db.guestMealRequest.findUniqueOrThrow({ where: { id: guest.id } });
    expect(final.quantity).toBe(2);
    expect(final.totalPriceMinor).toBe(10_000);
  });
});
