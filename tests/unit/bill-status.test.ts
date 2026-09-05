import { describe, expect, test } from "bun:test";
import { currentLocalDateMarker, effectiveBillStatus, isBillPastDueDate } from "@/lib/domain/bill-status";
import { localDateMidnightUtc, zonedTimeToUtc } from "@/lib/time";

const TZ = "Asia/Kolkata";
const dueDate = localDateMidnightUtc("2026-09-05");

describe("institution-local bill due-date semantics", () => {
  test("a bill remains due for the entire institution-local due calendar day", () => {
    const lateOnDueDay = zonedTimeToUtc(2026, 9, 5, 23, 59, TZ);

    expect(currentLocalDateMarker(TZ, lateOnDueDay).toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(isBillPastDueDate(dueDate, TZ, lateOnDueDay)).toBe(false);
    expect(
      effectiveBillStatus(
        { status: "GENERATED", dueDate, totalDueMinor: 5000, paymentsMinor: 0 },
        TZ,
        lateOnDueDay
      )
    ).toBe("GENERATED");
  });

  test("a bill becomes overdue only when the institution enters the next local day", () => {
    const nextLocalMidnight = zonedTimeToUtc(2026, 9, 6, 0, 0, TZ);

    expect(currentLocalDateMarker(TZ, nextLocalMidnight).toISOString()).toBe("2026-09-06T00:00:00.000Z");
    expect(isBillPastDueDate(dueDate, TZ, nextLocalMidnight)).toBe(true);
    expect(
      effectiveBillStatus(
        { status: "GENERATED", dueDate, totalDueMinor: 5000, paymentsMinor: 0 },
        TZ,
        nextLocalMidnight
      )
    ).toBe("OVERDUE");
  });

  test("partial and settled states take the correct precedence", () => {
    const dueDayNoon = zonedTimeToUtc(2026, 9, 5, 12, 0, TZ);
    const nextDay = zonedTimeToUtc(2026, 9, 6, 12, 0, TZ);

    expect(
      effectiveBillStatus(
        { status: "OVERDUE", dueDate, totalDueMinor: 2500, paymentsMinor: 2500 },
        TZ,
        dueDayNoon
      )
    ).toBe("PARTIALLY_PAID");
    expect(
      effectiveBillStatus(
        { status: "PARTIALLY_PAID", dueDate, totalDueMinor: 2500, paymentsMinor: 2500 },
        TZ,
        nextDay
      )
    ).toBe("OVERDUE");
    expect(
      effectiveBillStatus(
        { status: "OVERDUE", dueDate, totalDueMinor: 0, paymentsMinor: 5000 },
        TZ,
        nextDay
      )
    ).toBe("PAID");
    expect(
      effectiveBillStatus(
        { status: "VOIDED", dueDate, totalDueMinor: 5000, paymentsMinor: 0 },
        TZ,
        nextDay
      )
    ).toBe("VOIDED");
  });
});
