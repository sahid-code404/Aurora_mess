import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { refreshAndLock, refreshUnlockedEffective } from "@/lib/domain/meal-engine";

const prefix = "phase59-calendar-temporal-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

async function fixture(options: { futureLock?: boolean } = {}) {
  const institution = await db.institution.create({
    data: {
      name: unique("institution"),
      timezone: "UTC",
      settings: { create: { deficitPolicyEnabled: false, restrictMealsOnDeficit: false } },
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase59-calendar.test`,
      passwordHash: "phase59-test-only",
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
      cutoffLocalTime: "13:30",
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
  const lockAt = new Date(now.getTime() + (options.futureLock ? 60 * 60_000 : -5 * 60_000));
  const serviceStartAt = options.futureLock ? new Date(now.getTime() + 2 * 60 * 60_000) : lockAt;
  // Deliberately later than service start for the historical fixtures. This is
  // the edge case where cutoffAt is NOT the true freeze boundary.
  const cutoffAt = new Date(now.getTime() + (options.futureLock ? 60 * 60_000 : 60 * 60_000));
  const serviceEndAt = new Date(now.getTime() + 3 * 60 * 60_000);

  const instance = await db.mealInstance.create({
    data: {
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      mealDefinitionVersionId: version.id,
      serviceDate,
      serviceStartAt,
      serviceEndAt,
      cutoffAt,
      lockAt,
      status: "OPEN",
    },
  });
  const residentMeal = await db.residentMeal.create({
    data: {
      institutionId: institution.id,
      residentId: resident.id,
      mealInstanceId: instance.id,
      baselineState: "ON",
      effectiveState: "ON",
      effectiveReason: "BASELINE_DEFAULT",
    },
  });

  return {
    institution,
    resident,
    definition,
    instance,
    residentMeal,
    lockAt,
    serviceDate,
    key: serviceDate.toISOString().slice(0, 10),
  };
}

async function disablingEvent(
  fx: Awaited<ReturnType<typeof fixture>>,
  createdAt: Date,
  cancelledAt: Date | null
) {
  return db.calendarEvent.create({
    data: {
      institutionId: fx.institution.id,
      name: unique("event"),
      startDate: fx.serviceDate,
      endDate: fx.serviceDate,
      disableMeals: true,
      mealScope: "ALL_MEALS",
      createdAt,
      cancelledAt,
      cancelledByUserId: cancelledAt ? fx.resident.id : null,
      cancelReason: cancelledAt ? "test cancellation" : null,
    },
  });
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
    await db.calendarEventMeal.deleteMany({ where: { calendarEvent: { institutionId: { in: ids } } } });
    await db.calendarEvent.deleteMany({ where: { institutionId: { in: ids } } });
    const leaves = await db.leaveRequest.findMany({
      where: { institutionId: { in: ids } },
      select: { id: true },
    });
    const leaveIds = leaves.map((row) => row.id);
    if (leaveIds.length > 0) {
      await db.leaveRequestMeal.deleteMany({ where: { leaveRequestId: { in: leaveIds } } });
      await db.leaveRequest.deleteMany({ where: { id: { in: leaveIds } } });
    }
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
      select: { id: true, userProfileId: true },
    });
    const userIds = users.map((row) => row.id);
    const profileIds = users.flatMap((row) => (row.userProfileId ? [row.userProfileId] : []));
    if (userIds.length > 0) {
      await db.userStatusHistory.deleteMany({ where: { userId: { in: userIds } } });
      await db.session.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (profileIds.length > 0) {
      await db.userProfile.deleteMany({ where: { id: { in: profileIds } } });
    }
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("calendar and leave temporal lifecycle", () => {
  test("event cancelled after lock remains historical CALENDAR_DISABLED when lazy lock runs later", async () => {
    const fx = await fixture();
    await disablingEvent(
      fx,
      new Date(fx.lockAt.getTime() - 5 * 60_000),
      new Date(fx.lockAt.getTime() + 60_000)
    );

    await refreshAndLock(fx.institution.id, "UTC", fx.resident.id, fx.key, fx.key);

    const row = await db.residentMeal.findUniqueOrThrow({ where: { id: fx.residentMeal.id } });
    expect(row.lockedAt).not.toBeNull();
    expect(row.effectiveState).toBe("NOT_AVAILABLE");
    expect(row.effectiveReason).toBe("CALENDAR_DISABLED");
  });

  test("event cancelled before lock does not disable the later frozen meal", async () => {
    const fx = await fixture();
    await disablingEvent(
      fx,
      new Date(fx.lockAt.getTime() - 5 * 60_000),
      new Date(fx.lockAt.getTime() - 60_000)
    );

    await refreshAndLock(fx.institution.id, "UTC", fx.resident.id, fx.key, fx.key);

    const row = await db.residentMeal.findUniqueOrThrow({ where: { id: fx.residentMeal.id } });
    expect(row.lockedAt).not.toBeNull();
    expect(row.effectiveState).toBe("ON");
    expect(row.effectiveReason).toBe("BASELINE_DEFAULT");
  });

  test("event created after lock but before cutoff cannot retroactively disable the meal", async () => {
    const fx = await fixture();
    expect(fx.instance.cutoffAt.getTime()).toBeGreaterThan(fx.lockAt.getTime());
    await disablingEvent(fx, new Date(fx.lockAt.getTime() + 60_000), null);

    await refreshAndLock(fx.institution.id, "UTC", fx.resident.id, fx.key, fx.key);

    const row = await db.residentMeal.findUniqueOrThrow({ where: { id: fx.residentMeal.id } });
    expect(row.lockedAt).not.toBeNull();
    expect(row.effectiveState).toBe("ON");
    expect(row.effectiveReason).toBe("BASELINE_DEFAULT");
  });

  test("approved leave reviewed after lock but before cutoff cannot retroactively change the meal", async () => {
    const fx = await fixture();
    expect(fx.instance.cutoffAt.getTime()).toBeGreaterThan(fx.lockAt.getTime());
    await db.leaveRequest.create({
      data: {
        institutionId: fx.institution.id,
        residentId: fx.resident.id,
        startDate: fx.serviceDate,
        endDate: fx.serviceDate,
        reason: "late review",
        status: "APPROVED",
        reviewedAt: new Date(fx.lockAt.getTime() + 60_000),
      },
    });

    await refreshAndLock(fx.institution.id, "UTC", fx.resident.id, fx.key, fx.key);

    const row = await db.residentMeal.findUniqueOrThrow({ where: { id: fx.residentMeal.id } });
    expect(row.lockedAt).not.toBeNull();
    expect(row.effectiveState).toBe("ON");
    expect(row.effectiveReason).toBe("BASELINE_DEFAULT");
    expect(row.leaveState).toBeNull();
  });

  test("approved leave reviewed before lock remains historical ON_LEAVE", async () => {
    const fx = await fixture();
    await db.leaveRequest.create({
      data: {
        institutionId: fx.institution.id,
        residentId: fx.resident.id,
        startDate: fx.serviceDate,
        endDate: fx.serviceDate,
        reason: "timely review",
        status: "APPROVED",
        reviewedAt: new Date(fx.lockAt.getTime() - 60_000),
      },
    });

    await refreshAndLock(fx.institution.id, "UTC", fx.resident.id, fx.key, fx.key);

    const row = await db.residentMeal.findUniqueOrThrow({ where: { id: fx.residentMeal.id } });
    expect(row.lockedAt).not.toBeNull();
    expect(row.effectiveState).toBe("ON_LEAVE");
    expect(row.effectiveReason).toBe("LEAVE_APPROVED");
    expect(row.leaveState).toBe("ON_LEAVE");
  });

  test("cancelled event stops affecting a future unlocked meal on live refresh", async () => {
    const fx = await fixture({ futureLock: true });
    await disablingEvent(
      fx,
      new Date(Date.now() - 60 * 60_000),
      new Date(Date.now() - 60_000)
    );
    await db.residentMeal.update({
      where: { id: fx.residentMeal.id },
      data: { effectiveState: "NOT_AVAILABLE", effectiveReason: "CALENDAR_DISABLED" },
    });

    await refreshUnlockedEffective(fx.institution.id, fx.resident.id, fx.key, fx.key);

    const row = await db.residentMeal.findUniqueOrThrow({ where: { id: fx.residentMeal.id } });
    expect(row.lockedAt).toBeNull();
    expect(row.effectiveState).toBe("ON");
    expect(row.effectiveReason).toBe("BASELINE_DEFAULT");
  });
});
