import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { refreshAndLock } from "@/lib/domain/meal-engine";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createInstance(
  institutionId: string,
  label: string,
  serviceDate: Date,
  lockAt: Date,
  serviceStartAt: Date,
  serviceEndAt: Date,
  status: string
) {
  const definition = await db.mealDefinition.create({
    data: { institutionId, name: unique(label) },
  });
  const version = await db.mealDefinitionVersion.create({
    data: { mealDefinitionId: definition.id, version: 1, configSnapshotJson: "{}" },
  });
  return db.mealInstance.create({
    data: {
      institutionId,
      mealDefinitionId: definition.id,
      mealDefinitionVersionId: version.id,
      serviceDate,
      serviceStartAt,
      serviceEndAt,
      cutoffAt: lockAt,
      lockAt,
      status,
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("meal instance temporal lifecycle", () => {
  test("refresh persists LOCKED, SERVICE_ACTIVE, COMPLETED and preserves CANCELLED", async () => {
    const institution = await db.institution.create({ data: { name: unique("Temporal Mess"), timezone: "UTC" } });
    const now = new Date();
    const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const minute = 60_000;

    const locked = await createInstance(
      institution.id, "Locked", serviceDate,
      new Date(now.getTime() - 10 * minute), new Date(now.getTime() + 10 * minute), new Date(now.getTime() + 30 * minute), "OPEN"
    );
    const active = await createInstance(
      institution.id, "Active", serviceDate,
      new Date(now.getTime() - 20 * minute), new Date(now.getTime() - 5 * minute), new Date(now.getTime() + 20 * minute), "LOCKED"
    );
    const completed = await createInstance(
      institution.id, "Completed", serviceDate,
      new Date(now.getTime() - 60 * minute), new Date(now.getTime() - 30 * minute), new Date(now.getTime() - minute), "LOCKED"
    );
    const cancelled = await createInstance(
      institution.id, "Cancelled", serviceDate,
      new Date(now.getTime() - 60 * minute), new Date(now.getTime() - 30 * minute), new Date(now.getTime() - minute), "CANCELLED"
    );

    const key = serviceDate.toISOString().slice(0, 10);
    await refreshAndLock(institution.id, "UTC", null, key, key);

    const rows = await db.mealInstance.findMany({ where: { id: { in: [locked.id, active.id, completed.id, cancelled.id] } } });
    const status = new Map(rows.map((row) => [row.id, row.status]));
    expect(status.get(locked.id)).toBe("LOCKED");
    expect(status.get(active.id)).toBe("SERVICE_ACTIVE");
    expect(status.get(completed.id)).toBe("COMPLETED");
    expect(status.get(cancelled.id)).toBe("CANCELLED");
  });
});
