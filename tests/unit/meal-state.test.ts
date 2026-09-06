import { describe, expect, test } from "bun:test";

import {
  calculateNormalMealState,
  computeInstanceStatus,
  evaluateResidentMeal,
  scopedRowAffectsMeal,
  type MealEvalContext,
} from "../../src/lib/domain/meal-engine";

function ctx(overrides: Partial<MealEvalContext> = {}): MealEvalContext {
  return {
    visible: true,
    calendarDisabled: false,
    accountInactive: false,
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

  test("admin override remains authoritative over the soft deficit-policy gate", () => {
    expect(
      evaluateResidentMeal(null, ctx({ restricted: true, adminOverride: "ON", selected: "OFF" }))
    ).toEqual({
      effectiveState: "ON",
      effectiveReason: "ADMIN_OVERRIDE",
    });
  });

  test("admin override cannot bypass hard calendar, account, membership, cutoff, or leave eligibility", () => {
    expect(evaluateResidentMeal(null, ctx({ calendarDisabled: true, adminOverride: "ON" }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "CALENDAR_DISABLED",
    });
    expect(evaluateResidentMeal(null, ctx({ accountInactive: true, adminOverride: "ON" }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "ACCOUNT_INACTIVE",
    });
    expect(evaluateResidentMeal(null, ctx({ joinedAfterCutoff: true, adminOverride: "ON" }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "JOINED_AFTER_CUTOFF",
    });
    expect(evaluateResidentMeal(null, ctx({ membershipInactive: true, adminOverride: "ON" }))).toEqual({
      effectiveState: "NOT_AVAILABLE",
      effectiveReason: "MEMBERSHIP_INACTIVE",
    });
    expect(evaluateResidentMeal(null, ctx({ onLeave: true, adminOverride: "ON" }))).toEqual({
      effectiveState: "ON_LEAVE",
      effectiveReason: "LEAVE_APPROVED",
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
    const lockAt = new Date("2026-09-05T10:00:00.000Z");
    const start = new Date("2026-09-05T11:00:00.000Z");
    const end = new Date("2026-09-05T12:00:00.000Z");

    expect(computeInstanceStatus(new Date("2026-09-05T09:59:59.000Z"), lockAt, start, end)).toBe("OPEN");
    expect(computeInstanceStatus(new Date("2026-09-05T10:00:00.000Z"), lockAt, start, end)).toBe("LOCKED");
    expect(computeInstanceStatus(new Date("2026-09-05T11:00:00.000Z"), lockAt, start, end)).toBe("SERVICE_ACTIVE");
    expect(computeInstanceStatus(new Date("2026-09-05T12:00:00.000Z"), lockAt, start, end)).toBe("COMPLETED");
  });
});

describe("meal scope matching", () => {
  test("legacy/missing scope and ALL_MEALS remain backwards compatible", () => {
    expect(scopedRowAffectsMeal({}, "breakfast")).toBe(true);
    expect(scopedRowAffectsMeal({ mealScope: "ALL_MEALS", selectedMeals: [] }, "breakfast")).toBe(true);
  });

  test("SELECTED_MEALS affects only explicitly selected definitions", () => {
    const row = {
      mealScope: "SELECTED_MEALS",
      selectedMeals: [{ mealDefinitionId: "breakfast" }, { mealDefinitionId: "dinner" }],
    };

    expect(scopedRowAffectsMeal(row, "breakfast")).toBe(true);
    expect(scopedRowAffectsMeal(row, "dinner")).toBe(true);
    expect(scopedRowAffectsMeal(row, "lunch")).toBe(false);
  });

  test("empty SELECTED_MEALS fails closed rather than broadening to every meal", () => {
    expect(scopedRowAffectsMeal({ mealScope: "SELECTED_MEALS", selectedMeals: [] }, "lunch")).toBe(false);
  });
});
