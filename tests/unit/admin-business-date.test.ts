import { describe, expect, test } from "bun:test";
import { currentMonthKeyInTz, dateKeyInTz, todayKeyInTz } from "@/components/app/admin/_shared/business-date";

describe("admin institution-local business dates", () => {
  test("the same instant can belong to different business dates", () => {
    const instant = new Date("2026-09-06T00:30:00.000Z");

    expect(dateKeyInTz(instant, "Asia/Kolkata")).toBe("2026-09-06");
    expect(dateKeyInTz(instant, "America/Los_Angeles")).toBe("2026-09-05");
  });

  test("month selection follows the institution rather than the browser timezone", () => {
    const instant = new Date("2026-10-01T00:15:00.000Z");

    expect(todayKeyInTz("Asia/Kolkata", instant)).toBe("2026-10-01");
    expect(currentMonthKeyInTz("America/Los_Angeles", instant)).toBe("2026-09");
  });

  test("supports zones whose business day is already tomorrow in UTC", () => {
    const instant = new Date("2026-09-06T12:30:00.000Z");

    expect(dateKeyInTz(instant, "Pacific/Kiritimati")).toBe("2026-09-07");
  });
});
