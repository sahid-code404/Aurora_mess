import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("meal lock boundary source guards", () => {
  test("meal engine uses lockAt for join eligibility and writes the historical boundary", () => {
    const engine = source("src/lib/domain/meal-engine.ts");

    expect(engine).toContain("instance: { serviceDate: Date; cutoffAt: Date; lockAt: Date; mealDefinitionId: string }");
    expect(engine).toContain("from.getTime() > inputs.instance.lockAt.getTime()");
    expect(engine).toContain("from.getTime() > new Date(inst.lockAt).getTime()");
    expect(engine).toContain("from.getTime() > new Date(instRow.lockAt).getTime()");
    expect(engine).toContain("lockedAt: lockBoundary");
    expect(engine).not.toContain("from.getTime() > inputs.instance.cutoffAt.getTime()");
    expect(engine).not.toContain("from.getTime() > inst.cutoffAt.getTime()");
    expect(engine).not.toContain("from.getTime() > new Date(instRow.cutoffAt).getTime()");
    expect(engine).not.toContain("lockedAt: now,");
  });

  test("resident dashboard derives lock state from lockAt", () => {
    const dashboard = source("src/app/api/v1/me/dashboard/route.ts");

    expect(dashboard).toContain("locked: now.getTime() >= instance.lockAt.getTime()");
    expect(dashboard).toContain("lockAt: instance.lockAt.toISOString()");
    expect(dashboard).toContain("lockAt: g.mealInstance.lockAt.toISOString()");
    expect(dashboard).not.toContain("locked: now > instance.cutoffAt");
  });

  test("admin day sheet uses lockAt for frozen counts and exposes both configured cutoff and true lock", () => {
    const route = source("src/app/api/v1/admin/meals/route.ts");

    expect(route).toContain("mealInstance: { lockAt: { lte: now } }");
    expect(route).toContain("cutoffAt: i.cutoffAt.toISOString()");
    expect(route).toContain("lockAt: i.lockAt.toISOString()");
    expect(route).not.toContain("mealInstance: { cutoffAt: { lte: now } }");
  });

  test("admin resident override freezes at lockAt, not request time or configured cutoff", () => {
    const route = source("src/app/api/v1/admin/meals/[instanceId]/override/route.ts");

    expect(route).toContain("const lockBoundary = instance.lockAt");
    expect(route).toContain("const lockPassed = now.getTime() >= instance.lockAt.getTime()");
    expect(route).toContain("const lockedAt = rm.lockedAt ?? lockBoundary");
    expect(route).toContain("lockAt: lockBoundary.toISOString()");
    expect(route).not.toContain("instance.cutoffAt.getTime() ? now");
  });

  test("admin guest corrections still use lockAt and preserve consumed state after service end", () => {
    const route = source("src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts");

    expect(route).toContain("now.getTime() < instance.lockAt.getTime()");
    expect(route).toContain("const serviceEnded = now.getTime() >= instance.serviceEndAt.getTime()");
    expect(route).toContain('const nextActiveStatus = serviceEnded ? "CONSUMED" : "LOCKED"');
    expect(route).toContain("lockedAt: primary.lockedAt ?? lockBoundary");
    expect(route).toContain("lockedAt: lockBoundary");
    expect(route).not.toContain("lockedAt: now");
    expect(route).not.toContain("formatTimeLabel(instance.cutoffAt, inst.timezone)");
    expect(route).not.toContain('request.status === "CONSUMED"');
  });
});