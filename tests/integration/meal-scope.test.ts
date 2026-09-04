import { describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  ensureInstancesForRange,
  ensureResidentMeals,
  keyOfUtcDate,
  refreshUnlockedEffective,
} from "@/lib/domain/meal-engine";
import { invalidateInstitutionCache } from "@/lib/institution";

const FROM = "2027-01-11"; // Monday
const TO = "2027-01-13"; // Wednesday
const MID = (key: string) => new Date(`${key}T00:00:00.000Z`);

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createFixture() {
  const institution = await db.institution.create({
    data: {
      name: unique("Meal Scope Mess"),
      timezone: "Asia/Kolkata",
      settings: {
        create: {
          deficitPolicyEnabled: false,
          restrictMealsOnDeficit: false,
        },
      },
    },
  });

  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("meal-scope-resident")}@example.test`,
      passwordHash: "integration-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const breakfast = await db.mealDefinition.create({
    data: {
      institutionId: institution.id,
      name: unique("Breakfast"),
      active: true,
      defaultState: "ON",
      defaultVisible: true,
      scheduleStrategy: "DAILY",
      serviceStartLocal: "08:00",
      serviceEndLocal: "09:00",
      cutoffStrategy: "SAME_DAY",
      cutoffLocalTime: "06:00",
    },
  });

  const lunch = await db.mealDefinition.create({
    data: {
      institutionId: institution.id,
      name: unique("Lunch"),
      active: true,
      defaultState: "ON",
      defaultVisible: true,
      scheduleStrategy: "DAILY",
      serviceStartLocal: "13:00",
      serviceEndLocal: "14:00",
      cutoffStrategy: "SAME_DAY",
      cutoffLocalTime: "10:00",
    },
  });

  const dinner = await db.mealDefinition.create({
    data: {
      institutionId: institution.id,
      name: unique("Dinner"),
      active: true,
      defaultState: "ON",
      defaultVisible: true,
      scheduleStrategy: "WEEKDAYS",
      weekdaysCsv: "1,3", // Monday + Wednesday
      serviceStartLocal: "20:00",
      serviceEndLocal: "21:00",
      cutoffStrategy: "SAME_DAY",
      cutoffLocalTime: "17:00",
    },
  });

  invalidateInstitutionCache();
  await ensureInstancesForRange(institution.id, institution.timezone, FROM, TO);
  await ensureResidentMeals(resident.id, institution.id, institution.timezone, FROM, TO);

  return { institution, resident, breakfast, lunch, dinner };
}

async function residentRows(residentId: string, institutionId: string) {
  return db.residentMeal.findMany({
    where: {
      residentId,
      mealInstance: {
        institutionId,
        serviceDate: { gte: MID(FROM), lte: MID(TO) },
      },
    },
    include: {
      mealInstance: {
        include: { definition: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

describe("selected meal scope", () => {
  test("selected weekday recurrence materializes only configured weekdays", async () => {
    const { institution, dinner } = await createFixture();

    const dinnerInstances = await db.mealInstance.findMany({
      where: {
        institutionId: institution.id,
        mealDefinitionId: dinner.id,
        serviceDate: { gte: MID(FROM), lte: MID(TO) },
      },
      orderBy: { serviceDate: "asc" },
    });

    expect(dinnerInstances.map((instance) => keyOfUtcDate(instance.serviceDate))).toEqual([
      "2027-01-11",
      "2027-01-13",
    ]);
  });

  test("Breakfast + Dinner leave keeps Lunch completely normal", async () => {
    const { institution, resident, breakfast, lunch, dinner } = await createFixture();

    await db.leaveRequest.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        startDate: MID(FROM),
        endDate: MID(TO),
        reason: "Selected meal leave integration test",
        mealScope: "SELECTED_MEALS",
        status: "APPROVED",
        reviewedAt: new Date(),
        selectedMeals: {
          create: [
            { mealDefinitionId: breakfast.id },
            { mealDefinitionId: dinner.id },
          ],
        },
      },
    });

    await refreshUnlockedEffective(institution.id, resident.id, FROM, TO);
    const rows = await residentRows(resident.id, institution.id);

    const breakfastRows = rows.filter((row) => row.mealInstance.mealDefinitionId === breakfast.id);
    const lunchRows = rows.filter((row) => row.mealInstance.mealDefinitionId === lunch.id);
    const dinnerRows = rows.filter((row) => row.mealInstance.mealDefinitionId === dinner.id);

    expect(breakfastRows).toHaveLength(3);
    expect(breakfastRows.every((row) => row.effectiveState === "ON_LEAVE")).toBe(true);
    expect(breakfastRows.every((row) => row.leaveState === "ON_LEAVE")).toBe(true);

    expect(dinnerRows).toHaveLength(2);
    expect(dinnerRows.every((row) => row.effectiveState === "ON_LEAVE")).toBe(true);
    expect(dinnerRows.every((row) => row.leaveState === "ON_LEAVE")).toBe(true);

    expect(lunchRows).toHaveLength(3);
    expect(lunchRows.every((row) => row.effectiveState === "ON")).toBe(true);
    expect(lunchRows.every((row) => row.effectiveReason === "BASELINE_DEFAULT")).toBe(true);
    expect(lunchRows.every((row) => row.leaveState === null)).toBe(true);
  });

  test("Breakfast-only calendar event disables Breakfast and leaves Lunch available", async () => {
    const { institution, resident, breakfast, lunch } = await createFixture();

    await db.calendarEvent.create({
      data: {
        institutionId: institution.id,
        name: unique("Breakfast Maintenance"),
        startDate: MID(FROM),
        endDate: MID(TO),
        type: "MAINTENANCE",
        disableMeals: true,
        mealScope: "SELECTED_MEALS",
        selectedMeals: {
          create: [{ mealDefinitionId: breakfast.id }],
        },
      },
    });

    await refreshUnlockedEffective(institution.id, resident.id, FROM, TO);
    const rows = await residentRows(resident.id, institution.id);

    const breakfastRows = rows.filter((row) => row.mealInstance.mealDefinitionId === breakfast.id);
    const lunchRows = rows.filter((row) => row.mealInstance.mealDefinitionId === lunch.id);

    expect(breakfastRows).toHaveLength(3);
    expect(breakfastRows.every((row) => row.effectiveState === "NOT_AVAILABLE")).toBe(true);
    expect(breakfastRows.every((row) => row.effectiveReason === "CALENDAR_DISABLED")).toBe(true);

    expect(lunchRows).toHaveLength(3);
    expect(lunchRows.every((row) => row.effectiveState === "ON")).toBe(true);
    expect(lunchRows.every((row) => row.effectiveReason === "BASELINE_DEFAULT")).toBe(true);
  });

  test("ALL_MEALS remains backwards-compatible for leave", async () => {
    const { institution, resident } = await createFixture();

    await db.leaveRequest.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        startDate: MID(FROM),
        endDate: MID(TO),
        reason: "Legacy all-meals leave integration test",
        status: "APPROVED",
        reviewedAt: new Date(),
        // mealScope intentionally omitted: database default is ALL_MEALS.
      },
    });

    await refreshUnlockedEffective(institution.id, resident.id, FROM, TO);
    const rows = await residentRows(resident.id, institution.id);

    expect(rows).toHaveLength(8); // Breakfast 3 + Lunch 3 + Dinner Mon/Wed 2
    expect(rows.every((row) => row.effectiveState === "ON_LEAVE")).toBe(true);
    expect(rows.every((row) => row.leaveState === "ON_LEAVE")).toBe(true);
  });
});
