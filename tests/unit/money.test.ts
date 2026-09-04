import { describe, expect, test } from "bun:test";

import {
  divideMinorRoundHalfUp,
  formatMinor,
  multiplyRoundHalfUp,
  parseDecimalToMinor,
} from "../../src/lib/money";

describe("money invariants", () => {
  test("parses financial input into integer minor units", () => {
    expect(parseDecimalToMinor("₹1,234.56")).toBe(123456);
    expect(parseDecimalToMinor("0.01")).toBe(1);
    expect(parseDecimalToMinor("-12.50")).toBe(-1250);
  });

  test("rejects input precision beyond configured minor digits", () => {
    expect(parseDecimalToMinor("1.001")).toBeNull();
  });

  test("divides minor units by counts using half-up rounding", () => {
    expect(divideMinorRoundHalfUp(8500000, 1000)).toBe(8500);
    expect(divideMinorRoundHalfUp(5, 2)).toBe(3);
    expect(divideMinorRoundHalfUp(-5, 2)).toBe(-3);
  });

  test("multiplies quantities without introducing floating financial storage", () => {
    expect(multiplyRoundHalfUp(1.5, 5500)).toBe(8250);
  });

  test("formats integer minor units consistently", () => {
    expect(formatMinor(123456)).toBe("₹1,234.56");
    expect(formatMinor(-123456)).toBe("−₹1,234.56");
  });
});
