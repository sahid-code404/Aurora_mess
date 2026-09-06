import { describe, expect, test } from "bun:test";
import { computeMealLockAt, computeInstanceStatus } from "@/lib/domain/meal-engine";

describe("effective meal lock boundary", () => {
  test("service start wins when configured cutoff is later", () => {
    const serviceStart = new Date("2026-09-06T12:00:00.000Z");
    const configuredCutoff = new Date("2026-09-06T12:30:00.000Z");

    expect(computeMealLockAt(configuredCutoff, serviceStart).toISOString()).toBe(serviceStart.toISOString());
  });

  test("configured cutoff wins when it is earlier than service start", () => {
    const configuredCutoff = new Date("2026-09-06T09:00:00.000Z");
    const serviceStart = new Date("2026-09-06T12:00:00.000Z");

    expect(computeMealLockAt(configuredCutoff, serviceStart).toISOString()).toBe(configuredCutoff.toISOString());
  });

  test("instance becomes locked at lockAt even while service start is still in the future", () => {
    const lockAt = new Date("2026-09-06T09:00:00.000Z");
    const serviceStart = new Date("2026-09-06T12:00:00.000Z");
    const serviceEnd = new Date("2026-09-06T13:00:00.000Z");

    expect(computeInstanceStatus(new Date("2026-09-06T09:00:00.000Z"), lockAt, serviceStart, serviceEnd)).toBe("LOCKED");
    expect(computeInstanceStatus(new Date("2026-09-06T12:00:00.000Z"), lockAt, serviceStart, serviceEnd)).toBe("SERVICE_ACTIVE");
    expect(computeInstanceStatus(new Date("2026-09-06T13:00:00.000Z"), lockAt, serviceStart, serviceEnd)).toBe("COMPLETED");
  });
});
