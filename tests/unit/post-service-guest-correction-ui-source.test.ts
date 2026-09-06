import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../../src/components/app/admin/meals.tsx", import.meta.url), "utf8");

describe("post-service guest correction Admin UI", () => {
  test("uses the authoritative meal lock boundary", () => {
    expect(ui).toContain("lockAt: string");
    expect(ui).toContain("new Date(instance.instance.lockAt).getTime() <= Date.now()");
  });

  test("detects ended service and labels the action as a correction", () => {
    expect(ui).toContain("serviceEnded: boolean");
    expect(ui).toContain("new Date(instance.instance.serviceWindow.endAt).getTime() <= Date.now()");
    expect(ui).toContain('guestOverride.serviceEnded ? "Correct guest meal"');
    expect(ui).toContain("audited post-service correction");
  });

  test("explains billing propagation and uses correction-specific confirmation copy", () => {
    expect(ui).toContain("meal counts, guest income, Formula Engine variables and future billing");
    expect(ui).toContain("Correct to 0 guests");
    expect(ui).toContain("Correct to ${guestOverride.targetQuantity} guest");
  });
});
