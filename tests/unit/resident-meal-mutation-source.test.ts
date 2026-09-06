import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function expectActiveLockBefore(path: string, mutationNeedle: string) {
  const route = source(path);
  const tx = route.indexOf("db.$transaction");
  const lock = route.indexOf("await lockActiveResidentForMealMutation", tx);
  const mutation = route.indexOf(mutationNeedle, lock);
  expect(tx).toBeGreaterThan(-1);
  expect(lock).toBeGreaterThan(tx);
  expect(mutation).toBeGreaterThan(lock);
}

describe("resident meal mutation source contracts", () => {
  test("resident normal meal toggle locks ACTIVE account before materialization/write", () => {
    const path = "src/app/api/v1/meals/[instanceId]/toggle/route.ts";
    expectActiveLockBefore(path, "await ensureResidentMeals");
    const route = source(path);
    const lock = route.indexOf("await lockActiveResidentForMealMutation");
    expect(route.slice(lock)).not.toContain("await tx.user.findUnique");
  });

  test("admin normal meal override locks ACTIVE resident before materialization/write", () => {
    const path = "src/app/api/v1/admin/meals/[instanceId]/override/route.ts";
    expectActiveLockBefore(path, "await ensureResidentMeals");
    const route = source(path);
    const lock = route.indexOf("await lockActiveResidentForMealMutation");
    expect(route.slice(lock)).not.toContain("await tx.user.findFirst");
  });

  test("resident guest booking locks ACTIVE account before creating billable guest income", () => {
    const path = "src/app/api/v1/guest-meals/route.ts";
    const route = source(path);
    const post = route.indexOf('export const POST = route({ auth: "RESIDENT" }');
    const tx = route.indexOf("db.$transaction", post);
    const lock = route.indexOf("await lockActiveResidentForMealMutation", tx);
    const create = route.indexOf("await tx.guestMealRequest.create", lock);
    expect(lock).toBeGreaterThan(tx);
    expect(create).toBeGreaterThan(lock);
  });

  test("admin guest override locks ACTIVE resident before reading or rewriting guest rows", () => {
    const path = "src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts";
    expectActiveLockBefore(path, "await tx.guestMealRequest.findMany");
    const route = source(path);
    const lock = route.indexOf("await lockActiveResidentForMealMutation");
    expect(route.slice(lock)).not.toContain("await tx.user.findFirst");
  });

  test("resident guest cancellation validates and transitions inside one serialized transaction", () => {
    const route = source("src/app/api/v1/guest-meals/[id]/cancel/route.ts");
    const tx = route.indexOf("db.$transaction");
    const lock = route.indexOf("await lockActiveResidentForMealMutation", tx);
    const read = route.indexOf("await tx.guestMealRequest.findFirst", lock);
    const cutoff = route.indexOf("guest.mealInstance.lockAt", read);
    const update = route.indexOf("await tx.guestMealRequest.updateMany", cutoff);
    const audit = route.indexOf("await appendAudit", update);
    expect(lock).toBeGreaterThan(tx);
    expect(read).toBeGreaterThan(lock);
    expect(cutoff).toBeGreaterThan(read);
    expect(update).toBeGreaterThan(cutoff);
    expect(audit).toBeGreaterThan(update);
    expect(route).not.toContain("guestMealRequest.update({");
    expect(route.slice(update, audit)).toContain("status: guest.status");
  });

  test("admin guest cancellation uses immutable host key only before lock and re-reads lifecycle after lock", () => {
    const route = source("src/app/api/v1/admin/guest-meals/[id]/cancel/route.ts");
    const targetRead = route.indexOf("const target = await db.guestMealRequest.findFirst");
    const tx = route.indexOf("db.$transaction", targetRead);
    const lock = route.indexOf("await lockResidentLifecycleMutation", tx);
    const reread = route.indexOf("await tx.guestMealRequest.findFirst", lock);
    const update = route.indexOf("await tx.guestMealRequest.updateMany", reread);
    const audit = route.indexOf("await appendAudit", update);
    expect(targetRead).toBeGreaterThan(-1);
    expect(tx).toBeGreaterThan(targetRead);
    expect(lock).toBeGreaterThan(tx);
    expect(reread).toBeGreaterThan(lock);
    expect(update).toBeGreaterThan(reread);
    expect(audit).toBeGreaterThan(update);
    expect(route).not.toContain("guestMealRequest.update({");
    expect(route.slice(update, audit)).toContain("status: guest.status");
  });
});
