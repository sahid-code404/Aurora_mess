import { describe, expect, test } from "bun:test";

const schema = await Bun.file("prisma/schema.prisma").text();
const engine = await Bun.file("src/lib/domain/meal-engine.ts").text();
const override = await Bun.file("src/app/api/v1/admin/meals/[instanceId]/override/route.ts").text();
const guestOverride = await Bun.file("src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts").text();
const toggle = await Bun.file("src/app/api/v1/meals/[instanceId]/toggle/route.ts").text();
const definitionSchema = await Bun.file("src/lib/domain/meal-definition-schema.ts").text();

describe("meal instance temporal lifecycle source contracts", () => {
  test("live schema no longer defaults to the unreachable SCHEDULED state", () => {
    expect(schema).toContain('status                  String   @default("OPEN") // OPEN | LOCKED | SERVICE_ACTIVE | COMPLETED | CANCELLED');
    expect(engine).toContain('return "SERVICE_ACTIVE"');
    expect(engine).toContain('status: { not: "CANCELLED" }');
  });

  test("admin override eligibility uses authoritative lockAt rather than status != OPEN", () => {
    expect(override).toContain("now.getTime() >= instance.lockAt.getTime()");
    expect(guestOverride).toContain("now.getTime() >= instance.lockAt.getTime()");
    expect(override).not.toContain('instance.status !== "OPEN"');
    expect(guestOverride).not.toContain('instance.status !== "OPEN"');
  });

  test("cancelled meal service is terminal for resident and admin mutation routes", () => {
    expect(toggle).toContain('instance.status === "CANCELLED"');
    expect(override).toContain('instance.status === "CANCELLED"');
    expect(guestOverride).toContain('instance.status === "CANCELLED"');
  });

  test("same-day cutoff cannot be configured after service start", () => {
    expect(definitionSchema).toContain("Same-day cutoff cannot be after service starts.");
    expect(definitionSchema).toContain("cfg.cutoffLocalTime > cfg.serviceStartLocal");
  });
});
