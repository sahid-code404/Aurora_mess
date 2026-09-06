import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("finite policy exemption persistence", () => {
  test("schema and migration cannot preserve permanent exemptions", () => {
    const schema = source("prisma/schema.prisma");
    const migration = source("prisma/migrations/20260906_120000_finite_policy_exemptions/migration.sql");
    const start = schema.indexOf("model PolicyExemption {");
    const end = schema.indexOf("model PasswordResetToken", start);
    const model = schema.slice(start, end);

    expect(model).toContain("expiresAt        DateTime");
    expect(model).not.toContain("expiresAt        DateTime?");
    expect(migration).toContain('WHERE "expiresAt" IS NULL');
    expect(migration).toContain("POLICY_EXEMPTION_LEGACY_ENDED");
    expect(migration).toContain('ALTER TABLE "PolicyExemption" ALTER COLUMN "expiresAt" SET NOT NULL');
  });

  test("all authoritative active readers require a future expiry", () => {
    const domain = source("src/lib/domain/policy-exemption.ts");
    const funds = source("src/lib/domain/funds.ts");
    const adminFunds = source("src/app/api/v1/admin/funds/route.ts");
    const api = source("src/app/api/v1/admin/policy-exemptions/route.ts");

    for (const text of [domain, funds, adminFunds, api]) {
      expect(text).not.toContain("expiresAt: null");
      expect(text).not.toContain("legacyOpenEnded");
    }
    expect(domain).toContain("expiresAt: { gt: now }");
    expect(funds).toContain("expiresAt: { gt: new Date() }");
    expect(adminFunds).toContain("expiresAt: { gt: new Date() }");
    expect(api).toContain("expiresAt: { gt: now }");
  });

  test("admin surfaces no longer advertise an until-cancelled exemption", () => {
    const fundsUi = source("src/components/app/admin/funds.tsx");
    const types = source("src/components/app/admin/_shared/types.ts");
    expect(fundsUi).not.toContain("Until cancelled");
    expect(types).toContain("expiresAt: string;");
  });
});
