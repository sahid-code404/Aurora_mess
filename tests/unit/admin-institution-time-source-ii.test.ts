import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const paths = [
  "src/components/app/admin/audit.tsx",
  "src/components/app/admin/announcements.tsx",
  "src/components/app/admin/billing.tsx",
  "src/components/app/admin/expenses.tsx",
  "src/components/app/admin/formulas.tsx",
  "src/components/app/admin/calendar.tsx",
];

describe("admin institution-time source contracts II", () => {
  test("remaining month-scoped admin pages use institution current month", () => {
    for (const path of paths.slice(0, 5)) {
      const text = source(path);
      expect(text).toContain("currentMonthKeyInTz(tz)");
      expect(text).not.toContain("todayKey().slice(0, 7)");
    }
  });

  test("Audit and Announcements derive current month after session hydration", () => {
    for (const path of [paths[0], paths[1]]) {
      const text = source(path);
      expect(text).toContain("const [monthParam, setMonthParam] = useState<string | undefined>(undefined);");
      expect(text).toContain("const monthKey = monthParam ?? currentMonthKey;");
      expect(text).toContain("setMonthParam(undefined)");
      expect(text).not.toContain("useState<string>(currentMonthKey)");
    }
  });

  test("Expense defaults financial date from institution business day", () => {
    const expenses = source(paths[3]);
    expect(expenses).toContain("defaultDate={todayKeyInTz(tz)}");
    expect(expenses).toContain("if (open) setDate(defaultDate);");
    expect(expenses).toContain("const thisMonthKey = currentMonthKeyInTz(tz);");
    expect(expenses).not.toContain("useState(todayKey())");
  });

  test("Calendar follows institution today and a derived current month", () => {
    const calendar = source(paths[5]);
    expect(calendar).toContain("const serverToday = todayKeyInTz(tz);");
    expect(calendar).toContain("const activeMonthKey = monthParam ?? currentMonthKey;");
    expect(calendar).toContain("setMonthParam(undefined)");
    expect(calendar).not.toContain("const now = new Date();");
    expect(calendar).not.toContain("const serverToday = todayKey();");
  });

  test("browser-local current-day helper is absent from business-date pages", () => {
    for (const path of paths) {
      expect(source(path)).not.toContain("todayKey()");
    }
  });
});
