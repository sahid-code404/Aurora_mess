import { describe, expect, test } from "bun:test";

import {
  calculateNormalMealState,
  computeInstanceStatus,
  evaluateResidentMeal,
  type MealEvalContext,
} from "../../src/lib/domain/meal-engine";

function ctx(overrides: Partial<MealEvalContext> = {}): MealEvalContext {
  return {
    visible: true,
    calendarDisabled: false,
    onLeave: false,
    restricted: false,
    adminOverride: null,
    selected: null,
    baseline: "ON",
    membershipInactive: false,
    joinedAfterCutoff: false,
    ...overrides,
  };
}

describe("meal-state regression invariants", () => {
  test("uses the baseline when no higher-priority state exists", () => {
    expect(calculateNormalMealState(ctx())).toEqual({
      effectiveState: "ON",
      effectiveReason: "BASELINE_DEFAULT",
    });
  });

  test("resident selection overrides the baseline", () => {
    expect(calculateNormalMealState(ctx({ selected: "OFF" }))).toEqual({
      effectiveState: "OFF",
      effectiveReason: "RESIDENT_SELECTION",
    });
  });

  test("approved leave outranks resident selection", () => {
    expect(calculateNormalMealState(ctx({ onLeave: true, selected: "ON" }))).toEqual({
      effectiveState: "ON_LEAVE",
      effectiveReason: "LEAVE_APPROVED",
    });
  });

  test("deficit restriction outranks resident selection", () => {
    expect(calculateNormalMealState(ctx({ restricted: true, selected: "ON" }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "POLICY_RESTRICTED",
    });
  });

  test("current admin override behavior remains authoritative over normal state", () => {
    expect(
      evaluateResidentMeal(null, ctx({ restricted: true, adminOverride: "ON", selected: "OFF" }))
    ).toEqual({
      effectiveState: "ON",
      effectiveReason: "ADMIN_OVERRIDE",
    });
  });

  test("membership/cutoff failures remain explicit", () => {
    expect(calculateNormalMealState(ctx({ joinedAfterCutoff: true }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "JOINED_AFTER_CUTOFF",
    });
    expect(calculateNormalMealState(ctx({ membershipInactive: true }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "MEMBERSHIP_INACTIVE",
    });
  });

  test("instance status transitions are driven by authoritative timestamps", () => {
    const cutoff = new Date("2026-09-05T10:00:00.000Z");
    const end = new Date("2026-09-05T12:00:00.000Z");

    expect(computeInstanceStatus(new Date("2026-09-05T09:59:59.000Z"), cutoff, end)).toBe("OPEN");
    expect(computeInstanceStatus(new Date("2026-09-05T10:00:00.000Z"), cutoff, end)).toBe("LOCKED");
    expect(computeInstanceStatus(new Date("2026-09-05T12:00:00.000Z"), cutoff, end)).toBe("COMPLETED");
  });
});
