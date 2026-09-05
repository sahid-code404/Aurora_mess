import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/lib/domain/billing.ts", import.meta.url),
  "utf8"
);

describe("billing display-number allocation", () => {
  test("billing generation uses the shared atomic BILL range allocator", () => {
    expect(source).toContain('import { nextBillNumbers } from "@/lib/ids";');
    expect(source).toContain(
      "nextBillNumbers(period.year, period.month, residents.length, tx)"
    );
    expect(source).not.toContain("async function nextBillNumbers(client: any");
    expect(source).not.toContain("client.bill.count({ where: { billNumber:");
  });
});
