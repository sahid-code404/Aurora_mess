import { describe, expect, test } from "bun:test";
import { selectFormulaVersionAt } from "@/lib/domain/formula/effective-version";

describe("formula effective-window selection", () => {
  const versions = [
    {
      id: "future",
      version: 2,
      active: true,
      effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
      effectiveUntil: null,
    },
    {
      id: "september",
      version: 1,
      active: false,
      effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
      effectiveUntil: new Date("2026-09-30T23:59:59.999Z"),
    },
  ];

  test("a future active pointer cannot rewrite the current billing period", () => {
    const selected = selectFormulaVersionAt(versions, new Date("2026-09-01T00:00:00.000Z"));
    expect(selected?.id).toBe("september");
  });

  test("the future version becomes authoritative only inside its effective window", () => {
    const selected = selectFormulaVersionAt(versions, new Date("2026-10-01T00:00:00.000Z"));
    expect(selected?.id).toBe("future");
  });

  test("overlapping legacy windows resolve deterministically to the highest version", () => {
    const selected = selectFormulaVersionAt(
      [
        { version: 3, effectiveFrom: null, effectiveUntil: null, id: "v3" },
        { version: 8, effectiveFrom: null, effectiveUntil: null, id: "v8" },
      ],
      new Date("2026-09-01T00:00:00.000Z")
    );
    expect(selected?.id).toBe("v8");
  });

  test("returns null when no immutable version covers the requested period", () => {
    const selected = selectFormulaVersionAt(
      [
        {
          version: 1,
          effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
          effectiveUntil: null,
        },
      ],
      new Date("2026-09-01T00:00:00.000Z")
    );
    expect(selected).toBeNull();
  });
});
