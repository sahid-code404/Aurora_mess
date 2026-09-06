import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("policy exemption lifecycle source contracts", () => {
  test("grant API requires an expiry date and delegates to the serialized domain service", () => {
    const route = source("src/app/api/v1/admin/policy-exemptions/route.ts");
    expect(route).toContain("expiresAt: dateKeySchema,");
    expect(route).not.toContain("expiresAt: dateKeySchema.optional()");
    expect(route).toContain("await grantDeficitPolicyExemption");
    expect(route).not.toContain("await db.user.findFirst");
    expect(route).not.toContain("T23:59:59.999Z");
  });

  test("shared grant path locks the resident before authoritative state and overlap checks", () => {
    const domain = source("src/lib/domain/policy-exemption.ts");
    const lock = domain.indexOf("await lockResidentLifecycleMutation");
    const reread = domain.indexOf("tx.user.findUnique", lock);
    const overlap = domain.indexOf("tx.policyExemption.findFirst", reread);
    const create = domain.indexOf("tx.policyExemption.create", overlap);

    expect(lock).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(lock);
    expect(overlap).toBeGreaterThan(reread);
    expect(create).toBeGreaterThan(overlap);
    expect(domain).toContain("dateKeyInTz");
    expect(domain).toContain("policyExemptionExpiryAt");
  });

  test("cancellation discovers the mutex key then re-reads under the resident lock", () => {
    const domain = source("src/lib/domain/policy-exemption.ts");
    const cancelStart = domain.indexOf("export async function cancelDeficitPolicyExemption");
    const discovered = domain.indexOf("const discovered", cancelStart);
    const lock = domain.indexOf("await lockResidentLifecycleMutation", discovered);
    const reread = domain.indexOf("const exemption = await tx.policyExemption.findFirst", lock);
    const inactiveGuard = domain.indexOf("if (!isActive)", reread);
    const update = domain.indexOf("await tx.policyExemption.update", inactiveGuard);

    expect(discovered).toBeGreaterThan(cancelStart);
    expect(lock).toBeGreaterThan(discovered);
    expect(reread).toBeGreaterThan(lock);
    expect(inactiveGuard).toBeGreaterThan(reread);
    expect(update).toBeGreaterThan(inactiveGuard);
  });

  test("cancel API delegates to the shared lifecycle and not a raw expiresAt rewrite", () => {
    const route = source("src/app/api/v1/admin/policy-exemptions/[id]/cancel/route.ts");
    expect(route).toContain("await cancelDeficitPolicyExemption");
    expect(route).not.toContain("db.$transaction");
    expect(route).not.toContain("policyExemption.update");
  });
});
