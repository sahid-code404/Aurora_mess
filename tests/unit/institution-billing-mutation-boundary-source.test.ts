import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function expectOrder(text: string, first: string, second: string) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);
}

describe("institution billing mutation source boundary", () => {
  test("billing readiness takes Institution before resident settlement locks", () => {
    const lifecycle = source("src/lib/domain/guest-meal-lifecycle.ts");
    expectOrder(
      lifecycle,
      "await lockInstitutionFinancialMutation(client, options.institutionId);",
      "await lockInstitutionResidentFinancialMutations(client, options.institutionId);"
    );
    expectOrder(
      lifecycle,
      "await lockInstitutionResidentFinancialMutations(client, options.institutionId);",
      "const rows = await client.guestMealRequest.findMany("
    );
  });

  test("direct expense creation takes the mutex and authoritative period guard before insert", () => {
    const route = source("src/app/api/v1/admin/expenses/route.ts");
    expectOrder(route, "await lockInstitutionFinancialMutation(tx, ctx.institutionId);", "await assertExpensePeriodMutable(tx, ctx.institutionId, dateKey.data!);");
    expectOrder(route, "await assertExpensePeriodMutable(tx, ctx.institutionId, dateKey.data!);", "const created = await tx.expense.create(");
    expect(route).toContain('status: { in: ["BILLED", "REOPENED"] }');
  });

  test("expense review transitions cannot cross billing readiness or mutate frozen months", () => {
    const approve = source("src/app/api/v1/admin/expenses/[id]/approve/route.ts");
    const reject = source("src/app/api/v1/admin/expenses/[id]/reject/route.ts");
    const voidRoute = source("src/app/api/v1/admin/expenses/[id]/void/route.ts");

    for (const route of [approve, reject, voidRoute]) {
      expectOrder(route, "await lockInstitutionFinancialMutation(tx, ctx.institutionId);", "const expense = await tx.expense.findFirst(");
    }
    expectOrder(approve, "await assertExpensePeriodMutable(tx, ctx.institutionId, expense.date.toISOString().slice(0, 10));", "const guard = await tx.expense.updateMany(");
    expectOrder(voidRoute, "await assertExpensePeriodMutable(tx, ctx.institutionId, expense.date.toISOString().slice(0, 10));", "const guard = await tx.expense.updateMany(");
  });

  test("task SUBMITTED creation and review share the institution boundary", () => {
    const submit = source("src/app/api/v1/tasks/[id]/submission/route.ts");
    const approve = source("src/app/api/v1/admin/task-submissions/[id]/approve/route.ts");
    const reject = source("src/app/api/v1/admin/task-submissions/[id]/reject/route.ts");

    expectOrder(submit, "await lockInstitutionFinancialMutation(tx, ctx.institutionId);", "const task = await tx.task.findFirst(");
    expectOrder(submit, "await lockInstitutionFinancialMutation(tx, ctx.institutionId);", "const submission = await tx.taskSubmission.create(");
    expectOrder(approve, "await lockInstitutionFinancialMutation(tx, ctx.institutionId);", "const submission = await tx.taskSubmission.findUnique(");
    expectOrder(reject, "await lockInstitutionFinancialMutation(tx, ctx.institutionId);", "const submission = await tx.taskSubmission.findUnique(");
  });

  test("Market Task expenses retain submission business date and fail closed on frozen periods", () => {
    const approve = source("src/app/api/v1/admin/task-submissions/[id]/approve/route.ts");
    expect(approve).toContain("const expenseDateKey = dateKeyInTz(submission.submittedAt, tz);");
    expect(approve).toContain("const expenseDate = localDateMidnightUtc(expenseDateKey);");
    expectOrder(approve, "await assertExpensePeriodMutable(tx, ctx.institutionId, expenseDateKey);", "displayNumber = await nextExpenseNumber(tx, expenseDate);");
    expectOrder(approve, "displayNumber = await nextExpenseNumber(tx, expenseDate);", "const expense = await tx.expense.create(");
    expect(approve).not.toContain("const expenseDate = localDateMidnightUtc(dateKeyInTz(now, tz));");
  });
});