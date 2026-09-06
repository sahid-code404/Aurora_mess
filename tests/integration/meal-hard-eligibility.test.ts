import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { refreshAndLock, refreshUnlockedEffective } from "@/lib/domain/meal-engine";

const prefix = "phase56-hard-eligibility-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

async function fixture(lockPassed: boolean) {
  const institution = await db.institution.create({
    data: { name: unique("institution"), timezone: "UTC", settings: { create: {} } },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase56-resident.test`,
      passwordHash: "phase56-test-only",
    },
  });
  const definition = await db.mealDefinition.create({
    data: {
      institutionId: institution.id,
      name: unique("meal"),
      defaultState: "ON",
      defaultVisible: true,
      serviceStartLocal: "12:00",
      serviceEndLocal: "13:00",
      cutoffLocalTime: "10:00",
    },
  });
  const version = await db.mealDefinitionVersion.create({
    data: {
      mealDefinitionId: definition.id,
      version: 1,
      configSnapshotJson: JSON.stringify({ defaultState: "ON", defaultVisible: true }),
    },
  });
  const now = new Date();
  const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const lockAt = new Date(now.getTime() + (lockPassed ? -60_000 : 60 * 60_000));
  const startAt = new Date(now.getTime() + 2 * 60 * 60_000);
  const endAt = new Date(now.getTime() + 3 * 60 * 60_000);
  const instance = await db.mealInstance.create({
    data: {
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      mealDefinitionVersionId: version.id,
      serviceDate,
      serviceStartAt: startAt,
      serviceEndAt: endAt,
      cutoffAt: lockAt,
      lockAt,
      status: lockPassed ? "LOCKED" : "OPEN",
    },
  });
  const residentMeal = await db.residentMeal.create({
    data: {
      institutionId: institution.id,
      residentId: resident.id,
      mealInstanceId: instance.id,
      baselineState: "ON",
      adminOverrideState: "ON",
      effectiveState: "ON",
      effectiveReason: "ADMIN_OVERRIDE",
    },
  });
  return { institution, resident, instance, residentMeal, key: serviceDate.toISOString().slice(0, 10) };
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
    await db.userStatusHistory.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.session.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.userProfile.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("meal hard eligibility", () => {
  test("live refresh makes an inactive resident unavailable even with an ON admin override", async () => {
    const { institution, resident, residentMeal, key } = await fixture(false);
    await db.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });

    await refreshUnlockedEffective(institution.id, null, key, key);

    const updated = await db.residentMeal.findUniqueOrThrow({ where: { id: residentMeal.id } });
    expect(updated.effectiveState).toBe("NOT_AVAILABLE");
    expect(updated.effectiveReason).toBe("ACCOUNT_INACTIVE");
    expect(updated.adminOverrideState).toBe("ON");
    expect(updated.lockedAt).toBeNull();
  });

  test("cutoff freeze keeps an inactive resident non-billable despite an ON admin override", async () => {
    const { institution, resident, residentMeal, key } = await fixture(true);
    await db.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });

    await refreshAndLock(institution.id, "UTC", null, key, key);

    const updated = await db.residentMeal.findUniqueOrThrow({ where: { id: residentMeal.id } });
    expect(updated.effectiveState).toBe("NOT_AVAILABLE");
    expect(updated.effectiveReason).toBe("ACCOUNT_INACTIVE");
    expect(updated.adminOverrideState).toBe("ON");
    expect(updated.lockedAt).not.toBeNull();
  });
});
