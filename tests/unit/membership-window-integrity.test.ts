import { describe, expect, test } from "bun:test";
import { membershipBoundaryChangeTouchesPeriod } from "@/lib/domain/membership-window";

const start = new Date("2026-09-01T00:00:00.000Z");
const end = new Date("2026-10-01T00:00:00.000Z");
const beforeA = new Date("2026-07-01T00:00:00.000Z");
const beforeB = new Date("2026-08-15T00:00:00.000Z");
const insideA = new Date("2026-09-10T00:00:00.000Z");
const insideB = new Date("2026-09-20T00:00:00.000Z");
const afterA = new Date("2026-10-10T00:00:00.000Z");
const afterB = new Date("2026-11-01T00:00:00.000Z");

describe("membership billed-period boundary classification", () => {
  test("unchanged boundaries never rewrite a period", () => {
    expect(membershipBoundaryChangeTouchesPeriod(null, null, "FROM", start, end)).toBe(false);
    expect(membershipBoundaryChangeTouchesPeriod(insideA, insideA, "UNTIL", start, end)).toBe(false);
  });

  test("start-date changes entirely before or after a period are harmless to that period", () => {
    expect(membershipBoundaryChangeTouchesPeriod(beforeA, beforeB, "FROM", start, end)).toBe(false);
    expect(membershipBoundaryChangeTouchesPeriod(afterA, afterB, "FROM", start, end)).toBe(false);
  });

  test("start-date crossings, in-period moves, and clearing a historical start are detected", () => {
    expect(membershipBoundaryChangeTouchesPeriod(beforeA, insideA, "FROM", start, end)).toBe(true);
    expect(membershipBoundaryChangeTouchesPeriod(insideA, insideB, "FROM", start, end)).toBe(true);
    expect(membershipBoundaryChangeTouchesPeriod(insideA, null, "FROM", start, end)).toBe(true);
    expect(membershipBoundaryChangeTouchesPeriod(null, afterA, "FROM", start, end)).toBe(true);
  });

  test("end-date changes entirely before or after a period are harmless to that period", () => {
    expect(membershipBoundaryChangeTouchesPeriod(beforeA, beforeB, "UNTIL", start, end)).toBe(false);
    expect(membershipBoundaryChangeTouchesPeriod(afterA, afterB, "UNTIL", start, end)).toBe(false);
    expect(membershipBoundaryChangeTouchesPeriod(afterA, null, "UNTIL", start, end)).toBe(false);
  });

  test("end-date crossings, in-period moves, and clearing an in-period end are detected", () => {
    expect(membershipBoundaryChangeTouchesPeriod(afterA, insideA, "UNTIL", start, end)).toBe(true);
    expect(membershipBoundaryChangeTouchesPeriod(insideA, insideB, "UNTIL", start, end)).toBe(true);
    expect(membershipBoundaryChangeTouchesPeriod(insideA, null, "UNTIL", start, end)).toBe(true);
    expect(membershipBoundaryChangeTouchesPeriod(null, insideA, "UNTIL", start, end)).toBe(true);
  });
});
