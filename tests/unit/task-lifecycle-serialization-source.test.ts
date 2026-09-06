import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("task lifecycle serialization source contracts", () => {
  test("resident accept, reject and start lock the task before re-reading status", () => {
    for (const action of ["accept", "reject", "start"]) {
      const text = source(`src/app/api/v1/tasks/[id]/${action}/route.ts`);
      expect(text).toContain('import { lockTaskLifecycleMutation } from "@/lib/domain/task-lifecycle";');
      const lock = text.indexOf("await lockTaskLifecycleMutation(tx, ctx.institutionId, ctx.params.id);");
      const read = text.indexOf("const task = await tx.task.findFirst");
      expect(lock).toBeGreaterThan(-1);
      expect(read).toBeGreaterThan(lock);
    }
  });

  test("submission preserves global lock order Institution then Task then state re-read", () => {
    const text = source("src/app/api/v1/tasks/[id]/submission/route.ts");
    const institutionLock = text.indexOf("await lockInstitutionFinancialMutation(tx, ctx.institutionId);");
    const taskLock = text.indexOf("await lockTaskLifecycleMutation(tx, ctx.institutionId, ctx.params.id);");
    const read = text.indexOf("const task = await tx.task.findFirst", taskLock);
    expect(institutionLock).toBeGreaterThan(-1);
    expect(taskLock).toBeGreaterThan(institutionLock);
    expect(read).toBeGreaterThan(taskLock);
  });

  test("Admin cancellation is active-only, audited, reasoned and resident-visible", () => {
    const route = source("src/app/api/v1/admin/tasks/[id]/cancel/route.ts");
    expect(route).toContain('const CANCELLABLE = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);');
    expect(route).toContain("await lockTaskLifecycleMutation(tx, ctx.institutionId, ctx.params.id);");
    expect(route).toContain('status: "CANCELLED", adminReviewReason: body.reason');
    expect(route).toContain('action: "TASK_CANCELLED"');
    expect(route).toContain('type: "TASK_CANCELLED"');
    expect(route).toContain("Submitted work must be approved or rejected instead of cancelled.");
  });

  test("Admin task UI exposes rejected/cancelled history and reason-required cancellation", () => {
    const text = source("src/components/app/admin/tasks.tsx");
    expect(text).toContain('{ value: "REJECTED_BY_ADMIN", label: "Review Rejected" }');
    expect(text).toContain('{ value: "CANCELLED", label: "Cancelled" }');
    expect(text).toContain('await postJson(`${TASKS_PATH}/${task.id}/cancel`, { reason });');
    expect(text).toContain('reasonPlaceholder="Why is this task being cancelled? (required)"');
    expect(text).toContain('label="Cancellation reason"');
  });

  test("Resident task UI treats CANCELLED as terminal, not overdue or active", () => {
    const text = source("src/components/app/resident/tasks.tsx");
    expect(text).toContain('{ value: "REJECTED_BY_ADMIN", label: "Admin Rejected" }');
    expect(text).toContain('{ value: "CANCELLED", label: "Cancelled" }');
    expect(text).toContain('task.status !== "CANCELLED" && <TaskProgressStepper status={task.status} />');
    expect(text).toContain('task.status !== "REJECTED_BY_ADMIN" &&\n    task.status !== "CANCELLED"');
    expect(text).toContain('t.status === "REJECTED_BY_ADMIN" ||\n        t.status === "CANCELLED"');
    expect(text).toContain('"Task Cancelled by Admin"');
    expect(text).toContain("const monthKey = monthParam ?? currentMonthKey;");
  });

  test("shared status and notification icon maps recognize task cancellation", () => {
    const badge = source("src/components/glass/StatusBadge.tsx");
    const icons = source("src/components/app/resident/_shared/icons.tsx");
    const format = source("src/components/app/resident/_shared/format.ts");
    expect(badge).toContain('CANCELLED: "neutral"');
    expect(badge).toContain('CANCELLED: "Cancelled"');
    expect(icons).toContain("TASK_CANCELLED: TriangleAlert");
    expect(format).toContain("TASK_CANCELLED: TriangleAlert");
  });
});