import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  deriveGuestMealLifecycleStatus,
  refreshGuestMealLifecycle,
} from "@/lib/domain/guest-meal-lifecycle";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let institutionId = "";
let definitionId = "";
let versionId = "";
let futureGuestId = "";
let lockedGuestId = "";
let consumedGuestId = "";
let cancelledGuestId = "";

beforeAll(async () => {
  const institution = await db.institution.create({ data: { name: `Phase24 ${suffix}` } });
  institutionId = institution.id;

  const definition = await db.mealDefinition.create({
    data: {
      institutionId,
      name: `Phase24 meal ${suffix}`,
      serviceStartLocal: "12:00",
      serviceEndLocal: "13:00",
      cutoffLocalTime: "10:00",
    },
  });
  definitionId = definition.id;

  const version = await db.mealDefinitionVersion.create({
    data: { mealDefinitionId: definitionId, version: 1, configSnapshotJson: "{}" },
  });
  versionId = version.id;

  const now = new Date();
  const makeInstance = async (offset: number, cutoffOffset: number, endOffset: number) =>
    db.mealInstance.create({
      data: {
        institutionId,
        mealDefinitionId: definitionId,
        mealDefinitionVersionId: versionId,
        serviceDate: new Date(Date.UTC(2030, 0, 1 + offset)),
        serviceStartAt: new Date(now.getTime() + endOffset - 30_000),
        serviceEndAt: new Date(now.getTime() + endOffset),
        cutoffAt: new Date(now.getTime() + cutoffOffset),
        lockAt: new Date(now.getTime() + cutoffOffset),
        status: "OPEN",
      },
    });

  const future = await makeInstance(0, 60_000, 120_000);
  const locked = await makeInstance(1, -60_000, 60_000);
  const consumed = await makeInstance(2, -120_000, -60_000);
  const cancelled = await makeInstance(3, -120_000, -60_000);

  futureGuestId = (
    await db.guestMealRequest.create({
      data: {
        institutionId,
        hostResidentId: `resident-${suffix}`,
        mealInstanceId: future.id,
        quantity: 1,
        unitPriceMinor: 5500,
        totalPriceMinor: 5500,
        status: "CONFIRMED",
      },
    })
  ).id;
  lockedGuestId = (
    await db.guestMealRequest.create({
      data: {
        institutionId,
        hostResidentId: `resident-${suffix}`,
        mealInstanceId: locked.id,
        quantity: 2,
        unitPriceMinor: 5500,
        totalPriceMinor: 11000,
        status: "CONFIRMED",
      },
    })
  ).id;
  consumedGuestId = (
    await db.guestMealRequest.create({
      data: {
        institutionId,
        hostResidentId: `resident-${suffix}`,
        mealInstanceId: consumed.id,
        quantity: 3,
        unitPriceMinor: 5500,
        totalPriceMinor: 16500,
        status: "LOCKED",
        lockedAt: new Date(now.getTime() - 120_000),
      },
    })
  ).id;
  cancelledGuestId = (
    await db.guestMealRequest.create({
      data: {
        institutionId,
        hostResidentId: `resident-${suffix}`,
        mealInstanceId: cancelled.id,
        quantity: 1,
        unitPriceMinor: 5500,
        totalPriceMinor: 5500,
        status: "CANCELLED",
      },
    })
  ).id;
});

afterAll(async () => {
  if (!institutionId) return;
  await db.guestMealRequest.deleteMany({ where: { institutionId } });
  await db.mealInstance.deleteMany({ where: { institutionId } });
  if (definitionId) await db.mealDefinitionVersion.deleteMany({ where: { mealDefinitionId: definitionId } });
  if (definitionId) await db.mealDefinition.delete({ where: { id: definitionId } });
  await db.institution.delete({ where: { id: institutionId } });
});

describe("guest meal lifecycle", () => {
  test("derives only time-valid forward transitions", () => {
    const now = new Date("2030-01-01T12:00:00.000Z");
    expect(
      deriveGuestMealLifecycleStatus(
        "CONFIRMED",
        new Date("2030-01-01T12:05:00.000Z"),
        new Date("2030-01-01T13:00:00.000Z"),
        now
      )
    ).toBe("CONFIRMED");
    expect(
      deriveGuestMealLifecycleStatus(
        "CONFIRMED",
        new Date("2030-01-01T11:00:00.000Z"),
        new Date("2030-01-01T13:00:00.000Z"),
        now
      )
    ).toBe("LOCKED");
    expect(
      deriveGuestMealLifecycleStatus(
        "LOCKED",
        new Date("2030-01-01T10:00:00.000Z"),
        new Date("2030-01-01T11:00:00.000Z"),
        now
      )
    ).toBe("CONSUMED");
    expect(
      deriveGuestMealLifecycleStatus(
        "CANCELLED",
        new Date("2030-01-01T10:00:00.000Z"),
        new Date("2030-01-01T11:00:00.000Z"),
        now
      )
    ).toBe("CANCELLED");
  });

  test("persists CONFIRMED -> LOCKED -> CONSUMED without touching terminal rows", async () => {
    const first = await refreshGuestMealLifecycle({ institutionId });
    expect(first.locked).toBe(1);
    expect(first.consumed).toBe(1);

    const [future, locked, consumed, cancelled] = await Promise.all([
      db.guestMealRequest.findUniqueOrThrow({ where: { id: futureGuestId } }),
      db.guestMealRequest.findUniqueOrThrow({ where: { id: lockedGuestId } }),
      db.guestMealRequest.findUniqueOrThrow({ where: { id: consumedGuestId } }),
      db.guestMealRequest.findUniqueOrThrow({ where: { id: cancelledGuestId } }),
    ]);

    expect(future.status).toBe("CONFIRMED");
    expect(locked.status).toBe("LOCKED");
    expect(locked.lockedAt).not.toBeNull();
    expect(consumed.status).toBe("CONSUMED");
    expect(cancelled.status).toBe("CANCELLED");

    const second = await refreshGuestMealLifecycle({ institutionId });
    expect(second).toEqual({ locked: 0, consumed: 0 });
  });
});
