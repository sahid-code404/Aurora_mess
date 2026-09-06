import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ensureResidentMeals, refreshAndLock } from "@/lib/domain/meal-engine";

const prefix = "phase61-lock-boundary-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    await db.residentMeal.deleteMany({ where: { institutionId: { in: ids } } });
    await db.guestMealRequest.deleteMany({ where: { institutionId: { in: ids } } });
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
    const users = await db.user.findMany({
      where: { institutionId: { in: ids } },
      select: { id: true },
    });
    const userIds = users.map((row) => row.id);
    if (userIds.length > 0) {
      await db.userStatusHistory.deleteMany({ where: { userId: { in: userIds } } });
      await db.session.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("meal lock boundary integrity", () => {
  test("service start wins over a later configured cutoff for membership eligibility and frozen history", async () => {
    const institution = await db.institution.create({
      data: {
        name: unique("institution"),
        timezone: "UTC",
        settings: {
          create: {
            deficitPolicyEnabled: false,
            restrictMealsOnDeficit: false,
          },
        },
      },
    });

    const now = new Date();
    const minute = 60_000;
    const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const serviceStartAt = new Date(now.getTime() - 10 * minute);
    const lockAt = serviceStartAt;
    const configuredCutoffAt = new Date(now.getTime() + 20 * minute);
    const serviceEndAt = new Date(now.getTime() + 50 * minute);
    const joinedAfterLockButBeforeConfiguredCutoff = new Date(now.getTime() - 5 * minute);

    const resident = await db.user.create({
      data: {
        institutionId: institution.id,
        role: "RESIDENT",
        status: "ACTIVE",
        email: `${crypto.randomUUID()}@phase61-lock.test`,
        passwordHash: "phase61-test-only",
        membershipEffectiveFrom: joinedAfterLockButBeforeConfiguredCutoff,
      },
    });

    const definition = await db.mealDefinition.create({
      data: {
        institutionId: institution.id,
        name: unique("meal"),
        defaultState: "ON",
        defaultVisible: true,
      },
    });
    const version = await db.mealDefinitionVersion.create({
      data: {
        mealDefinitionId: definition.id,
        version: 1,
        configSnapshotJson: JSON.stringify({ defaultState: "ON", defaultVisible: true }),
      },
    });
    const instance = await db.mealInstance.create({
      data: {
        institutionId: institution.id,
        mealDefinitionId: definition.id,
        mealDefinitionVersionId: version.id,
        serviceDate,
        serviceStartAt,
        serviceEndAt,
        cutoffAt: configuredCutoffAt,
        lockAt,
        status: "SERVICE_ACTIVE",
      },
    });

    const key = serviceDate.toISOString().slice(0, 10);
    expect(await ensureResidentMeals(resident.id, institution.id, "UTC", key, key)).toBe(1);

    const materialized = await db.residentMeal.findUniqueOrThrow({
      where: {
        residentId_mealInstanceId: {
          residentId: resident.id,
          mealInstanceId: instance.id,
        },
      },
    });
    expect(materialized.effectiveState).toBe("NOT_AVAILABLE");
    expect(materialized.effectiveReason).toBe("JOINED_AFTER_CUTOFF");
    expect(materialized.lockedAt).toBeNull();

    await refreshAndLock(institution.id, "UTC", resident.id, key, key);

    const frozen = await db.residentMeal.findUniqueOrThrow({ where: { id: materialized.id } });
    expect(frozen.effectiveState).toBe("NOT_AVAILABLE");
    expect(frozen.effectiveReason).toBe("JOINED_AFTER_CUTOFF");
    expect(frozen.lockedAt?.getTime()).toBe(lockAt.getTime());
    expect(frozen.lockedAt?.getTime()).toBeLessThan(configuredCutoffAt.getTime());
  });
});
