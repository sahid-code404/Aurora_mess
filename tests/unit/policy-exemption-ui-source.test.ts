import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Resident 360 policy exemption UI contract", () => {
  test("finite backend exemption lifecycle is represented truthfully in the form", () => {
    const view = source("src/components/app/admin/resident360.tsx");

    expect(view).toContain('timeZone={tz}');
    expect(view).toContain('label="Expires on"');
    expect(view).toContain('const valid = reason.trim().length >= 3 && expiresAt.length > 0 && !expiryError;');
    expect(view).toContain('expiresAt,');
    expect(view).toContain('dateKeyInTimeZone(new Date(), timeZone)');
    expect(view).toContain('expiresAt < todayKey');
    expect(view).toContain('is exempt through ${expiresAt}.');

    expect(view).not.toContain('label="Expires on (optional)"');
    expect(view).not.toContain('Leave empty to keep the exemption until cancelled.');
    expect(view).not.toContain('expiresAt: expiresAt || undefined');
    expect(view).not.toContain('expiresAt || "cancelled"');
  });
});
