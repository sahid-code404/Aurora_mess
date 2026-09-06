import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("resident deletion lifecycle source contracts", () => {
  test("domain uses the resident mutex, seven-day grace, task guard and retained tombstone semantics", () => {
    const domain = source("src/lib/domain/resident-retirement.ts");

    expect(domain).toContain("RESIDENT_DELETION_GRACE_DAYS = 7");
    expect(domain).toContain("await lockResidentLifecycleMutation");
    expect(domain).toContain('status: { in: UNFINISHED_TASK_STATES }');
    expect(domain).toContain('data: { status: "PENDING_DELETION" }');
    expect(domain).toContain('data: { status: "COMPLETED", completedAt: now');
    expect(domain).toContain("historicalDataRetained: true");
    expect(domain).not.toContain("tx.user.delete(");
    expect(domain).not.toContain("tx.user.deleteMany(");
  });

  test("request endpoint revokes every live session only after scheduling commits", () => {
    const route = source("src/app/api/v1/admin/residents/[id]/request-deletion/route.ts");
    const schedule = route.indexOf("await scheduleResidentDeletion");
    const revoke = route.indexOf("await revokeAllUserSessions", schedule);

    expect(schedule).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(schedule);
    expect(route).toContain('route({ auth: "ADMIN" }');
  });

  test("cancel endpoint requires an audited reason and uses the shared domain transition", () => {
    const route = source("src/app/api/v1/admin/residents/[id]/cancel-deletion/route.ts");
    expect(route).toContain("reasonSchema");
    expect(route).toContain("await cancelResidentDeletion");
    expect(route).toContain('route({ auth: "ADMIN" }');
  });

  test("roster advances due requests and exposes deletion state plus financial context", () => {
    const route = source("src/app/api/v1/admin/residents/route.ts");
    expect(route).toContain("await refreshDueResidentRetirements(ctx.institutionId)");
    expect(route).toContain('entityType: "USER"');
    expect(route).toContain('u.status === "PENDING_DELETION"');
    expect(route).toContain("serializeResidentDeletionRequest");
    expect(route).toContain("deletion, nextCursor");
  });

  test("Admin roster exposes queue and restore actions without offering restore for completed tombstones", () => {
    const view = source("src/components/app/admin/residents.tsx");
    expect(view).toContain('"request-deletion"');
    expect(view).toContain('"cancel-deletion"');
    expect(view).toContain('value: "PENDING_DELETION", label: "Deletion"');
    expect(view).toContain('resident.deletionRequest?.status === "SCHEDULED"');
    expect(view).toContain('resident.deletionRequest?.status === "QUEUED"');
    expect(view).toContain('deletion?.status === "COMPLETED"');
  });

  test("resident deletion detail endpoint also advances server-time completion", () => {
    const route = source("src/app/api/v1/admin/residents/[id]/deletion/route.ts");
    expect(route).toContain("await refreshDueResidentRetirements(ctx.institutionId)");
    expect(route).toContain("serializeResidentDeletionRequest");
  });
});
