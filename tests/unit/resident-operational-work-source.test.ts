import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("resident operational work source contracts", () => {
  test("task assignment locks and re-reads the Resident before task creation", () => {
    const route = source("src/app/api/v1/admin/tasks/route.ts");
    const post = route.indexOf('export const POST = route({ auth: "ADMIN" }');
    const transaction = route.indexOf("db.$transaction", post);
    const residentGuard = route.indexOf("await lockActiveResidentForTaskAssignment", transaction);
    const taskCreate = route.indexOf("await tx.task.create", residentGuard);

    expect(post).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(post);
    expect(residentGuard).toBeGreaterThan(transaction);
    expect(taskCreate).toBeGreaterThan(residentGuard);
    expect(route.slice(post)).not.toContain("await tx.user.findFirst");
  });

  test("deactivation checks unfinished work after the Resident lock and before status mutation", () => {
    const route = source("src/app/api/v1/admin/residents/[id]/deactivate/route.ts");
    const transaction = route.indexOf("db.$transaction");
    const residentLock = route.indexOf("await lockResidentLifecycleMutation", transaction);
    const reread = route.indexOf("await tx.user.findUnique", residentLock);
    const workGuard = route.indexOf("await assertNoUnfinishedResidentTasks", reread);
    const update = route.indexOf("await tx.user.update", workGuard);

    expect(transaction).toBeGreaterThan(-1);
    expect(residentLock).toBeGreaterThan(transaction);
    expect(reread).toBeGreaterThan(residentLock);
    expect(workGuard).toBeGreaterThan(reread);
    expect(update).toBeGreaterThan(workGuard);
  });

  test("shared unfinished-task set covers every nonterminal resident-owned work state", () => {
    const domain = source("src/lib/domain/resident-operational-work.ts");
    for (const state of ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "SUBMITTED"]) {
      expect(domain).toContain(`"${state}"`);
    }
    for (const terminal of ["REJECTED", "APPROVED", "REJECTED_BY_ADMIN", "CANCELLED"]) {
      expect(domain.match(new RegExp(`\\"${terminal}\\"`, "g"))?.length ?? 0).toBe(0);
    }
  });
});
