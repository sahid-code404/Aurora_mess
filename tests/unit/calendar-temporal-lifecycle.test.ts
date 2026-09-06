import { describe, expect, test } from "bun:test";
import { calendarEventActiveAtBoundary } from "@/lib/domain/meal-engine";

const boundary = new Date("2026-09-06T12:00:00.000Z");

describe("calendar event temporal boundary", () => {
  test("an event created before lock and never cancelled is active", () => {
    expect(
      calendarEventActiveAtBoundary(
        { createdAt: new Date("2026-09-06T11:00:00.000Z"), cancelledAt: null },
        boundary
      )
    ).toBe(true);
  });

  test("cancellation after lock cannot rewrite the historical fact", () => {
    expect(
      calendarEventActiveAtBoundary(
        {
          createdAt: new Date("2026-09-06T11:00:00.000Z"),
          cancelledAt: new Date("2026-09-06T12:01:00.000Z"),
        },
        boundary
      )
    ).toBe(true);
  });

  test("cancellation at or before lock makes the event inactive at the boundary", () => {
    expect(
      calendarEventActiveAtBoundary(
        {
          createdAt: new Date("2026-09-06T11:00:00.000Z"),
          cancelledAt: new Date("2026-09-06T12:00:00.000Z"),
        },
        boundary
      )
    ).toBe(false);
    expect(
      calendarEventActiveAtBoundary(
        {
          createdAt: new Date("2026-09-06T11:00:00.000Z"),
          cancelledAt: new Date("2026-09-06T11:59:00.000Z"),
        },
        boundary
      )
    ).toBe(false);
  });

  test("an event created after lock cannot retroactively disable the meal", () => {
    expect(
      calendarEventActiveAtBoundary(
        { createdAt: new Date("2026-09-06T12:00:00.001Z"), cancelledAt: null },
        boundary
      )
    ).toBe(false);
  });
});
