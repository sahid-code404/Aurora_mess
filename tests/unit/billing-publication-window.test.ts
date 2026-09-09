import { describe, expect, test } from "bun:test";
import {
  billingPublicationWindow,
  billingPublishAt,
  normalizeBillingPublishDay,
  ordinalDay,
} from "@/lib/domain/billing-publication";

describe("billing publication window", () => {
  test("defaults to the fifth day of the following month in institution time", () => {
    expect(billingPublishAt(2026, 9, 5, "Asia/Kolkata").toISOString()).toBe(
      "2026-10-04T18:30:00.000Z"
    );
  });

  test("supports a custom first-day publication window", () => {
    expect(billingPublishAt(2026, 9, 1, "Asia/Kolkata").toISOString()).toBe(
      "2026-09-30T18:30:00.000Z"
    );
  });

  test("rolls December publication into January of the next year", () => {
    expect(billingPublishAt(2026, 12, 5, "Asia/Kolkata").toISOString()).toBe(
      "2027-01-04T18:30:00.000Z"
    );
  });

  test("keeps an active month LIVE", () => {
    const state = billingPublicationWindow({
      year: 2026,
      month: 9,
      publishDay: 5,
      timeZone: "Asia/Kolkata",
      now: new Date("2026-09-10T00:00:00.000Z"),
      periodStatus: "OPEN",
    });
    expect(state.state).toBe("LIVE");
    expect(state.monthEnded).toBe(false);
    expect(state.windowOpen).toBe(false);
  });

  test("keeps the ended month WAITING before configured publish day", () => {
    const state = billingPublicationWindow({
      year: 2026,
      month: 9,
      publishDay: 5,
      timeZone: "Asia/Kolkata",
      now: new Date("2026-10-02T12:00:00.000Z"),
      periodStatus: "OPEN",
    });
    expect(state.state).toBe("WAITING");
    expect(state.monthEnded).toBe(true);
    expect(state.windowOpen).toBe(false);
  });

  test("becomes READY when the configured publish day arrives", () => {
    const state = billingPublicationWindow({
      year: 2026,
      month: 9,
      publishDay: 5,
      timeZone: "Asia/Kolkata",
      now: new Date("2026-10-04T18:30:00.000Z"),
      periodStatus: "OPEN",
    });
    expect(state.state).toBe("READY");
    expect(state.monthEnded).toBe(true);
    expect(state.windowOpen).toBe(true);
  });

  test("published state stays published regardless of later live timing", () => {
    const state = billingPublicationWindow({
      year: 2026,
      month: 9,
      publishDay: 5,
      timeZone: "Asia/Kolkata",
      now: new Date("2026-10-10T00:00:00.000Z"),
      periodStatus: "BILLED",
    });
    expect(state.state).toBe("PUBLISHED");
  });

  test("normalizes invalid configured days to the safe default", () => {
    expect(normalizeBillingPublishDay(0)).toBe(5);
    expect(normalizeBillingPublishDay(29)).toBe(5);
    expect(normalizeBillingPublishDay(Number.NaN)).toBe(5);
  });

  test("formats simple ordinal day labels", () => {
    expect(ordinalDay(1)).toBe("1st");
    expect(ordinalDay(2)).toBe("2nd");
    expect(ordinalDay(3)).toBe("3rd");
    expect(ordinalDay(4)).toBe("4th");
    expect(ordinalDay(11)).toBe("11th");
    expect(ordinalDay(21)).toBe("21st");
    expect(ordinalDay(28)).toBe("28th");
  });
});
