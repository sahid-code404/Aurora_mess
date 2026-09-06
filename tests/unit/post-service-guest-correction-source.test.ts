import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("post-service guest meal correction contracts", () => {
  test("admin guest correction serializes billing before Resident lifecycle and freezes billed periods", () => {
    const route = source("src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts");
    const tx = route.indexOf("db.$transaction");
    const institutionLock = route.indexOf("await lockInstitutionFinancialMutation", tx);
    const periodLock = route.indexOf('FROM "BillingPeriod"', institutionLock);
    const residentLock = route.indexOf("await lockActiveResidentForMealMutation", periodLock);

    expect(tx).toBeGreaterThan(-1);
    expect(institutionLock).toBeGreaterThan(tx);
    expect(periodLock).toBeGreaterThan(institutionLock);
    expect(route.slice(periodLock, residentLock)).toContain("FOR UPDATE");
    expect(residentLock).toBeGreaterThan(periodLock);
    expect(route).toContain('period.status === "BILLED"');
    expect(route).toContain('period.status === "REOPENED"');
    expect(route).toContain('period.generationState === "CLOSING"');
  });

  test("ended service is corrected instead of hard-blocked and remains consumed", () => {
    const route = source("src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts");

    expect(route).toContain("const serviceEnded = now.getTime() >= instance.serviceEndAt.getTime()");
    expect(route).toContain('const nextActiveStatus = serviceEnded ? "CONSUMED" : "LOCKED"');
    expect(route).toContain('"GUEST_MEAL_POST_SERVICE_CORRECTED"');
    expect(route).toContain('"POST_SERVICE_CORRECTION"');
    expect(route).not.toContain("This meal service has already ended. Consumed guest-meal history cannot be rewritten");
    expect(route).not.toContain("Consumed guest meals are historical records and cannot be changed");
  });

  test("correcting to zero removes effective guest totals without deleting historical rows", () => {
    const route = source("src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts");
    const zero = route.indexOf("if (body.quantity === 0)");
    const nextBranch = route.indexOf("} else if (existing.length > 0)", zero);
    const zeroBlock = route.slice(zero, nextBranch);

    expect(zeroBlock).toContain('status: "CANCELLED"');
    expect(zeroBlock).toContain("await tx.guestMealRequest.update");
    expect(zeroBlock).not.toContain("guestMealRequest.delete");
  });

  test("Admin Meals UI labels ended-service edits as historical corrections and uses lockAt", () => {
    const ui = source("src/components/app/admin/meals.tsx");

    expect(ui).toContain("serviceEnded: boolean");
    expect(ui).toContain('new Date(instance.instance.serviceWindow.endAt).getTime() <= Date.now()');
    expect(ui).toContain('guestOverride.serviceEnded ? "Correct guest meal"');
    expect(ui).toContain("post-service historical correction");
    expect(ui).toContain("Correct to 0 guests");
    expect(ui).toContain("new Date(instance.instance.lockAt).getTime() <= Date.now()");
  });

  test("Admin day-sheet recognizes post-service correction provenance", () => {
    const route = source("src/app/api/v1/admin/meals/route.ts");
    expect(route).toContain("Admin post-service correction");
    expect(route).toContain("(?:Admin override|Admin post-service correction)");
  });
});
