import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("admin institution-time source contracts", () => {
  test("Funds current-month controls follow the institution timezone", () => {
    const funds = source("src/components/app/admin/funds.tsx");

    expect(funds).toContain('import { useSession } from "@/hooks/use-session";');
    expect(funds).toContain('import { currentMonthKeyInTz } from "./_shared/business-date";');
    expect(funds).toContain('const tz = institution?.timezone ?? "Asia/Kolkata";');
    expect(funds).toContain("const thisMonthKey = currentMonthKeyInTz(tz);");
    expect(funds).not.toContain("const thisMonthKey = todayKey().slice(0, 7)");
  });

  test("Tasks current-month and overdue logic use the institution business day", () => {
    const tasks = source("src/components/app/admin/tasks.tsx");

    expect(tasks).toContain(
      'import { currentMonthKeyInTz, todayKeyInTz } from "./_shared/business-date";'
    );
    expect(tasks).toContain("const todayDateKey = todayKeyInTz(tz);");
    expect(tasks).toContain("const currentMonthKey = currentMonthKeyInTz(tz);");
    expect(tasks).toContain("t.dueDate < todayDateKey");
    expect(tasks).not.toContain("t.dueDate < todayKey()");
    expect(tasks).not.toContain("const currentMonthKey = todayKey().slice(0, 7)");
  });

  test("Audit month filters and displayed event times follow the institution timezone", () => {
    const audit = source("src/components/app/admin/audit.tsx");

    expect(audit).toContain('import { useSession } from "@/hooks/use-session";');
    expect(audit).toContain('import { currentMonthKeyInTz } from "./_shared/business-date";');
    expect(audit).toContain('const tz = institution?.timezone ?? "Asia/Kolkata";');
    expect(audit).toContain("const currentMonthKey = currentMonthKeyInTz(tz);");
    expect(audit).toContain("fmtDateTime(row.occurredAt, tz)");
    expect(audit).not.toContain("const currentMonthKey = todayKey().slice(0, 7)");
    expect(audit).not.toContain("fmtDateTime(row.occurredAt)}");
  });

  test("Funds deficit copy describes actual deficit state rather than an unrelated minimum", () => {
    const funds = source("src/components/app/admin/funds.tsx");
    expect(funds).toContain('sub: `${deficitResidents.length} with deficit`');
    expect(funds).not.toContain('sub: `${deficitResidents.length} below min`');
  });
});