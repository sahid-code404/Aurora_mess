import { describe, expect, test } from "bun:test";
import { policyExemptionExpiryAt } from "@/lib/domain/policy-exemption";

describe("policy exemption local-calendar expiry", () => {
  test("covers the entire requested Asia/Kolkata local day", () => {
    expect(policyExemptionExpiryAt("2026-09-10", "Asia/Kolkata").toISOString()).toBe(
      "2026-09-10T18:29:59.999Z"
    );
  });

  test("uses the institution timezone rather than UTC end-of-day", () => {
    expect(policyExemptionExpiryAt("2026-09-10", "America/New_York").toISOString()).toBe(
      "2026-09-11T03:59:59.999Z"
    );
  });
});
