import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("archive lifecycle source contracts", () => {
  test("RuleDefinition no longer advertises an archive state runtime never enforced", () => {
    const schema = source("prisma/schema.prisma");
    const start = schema.indexOf("model RuleDefinition {");
    const end = schema.indexOf("model RuleVersion {", start);
    const model = schema.slice(start, end);
    expect(model).not.toContain("status");
    expect(model).toContain("@@index([institutionId, policyType])");
    expect(model).not.toContain("policyType, status");

    const rules = source("src/lib/domain/rules/deficit-rules.ts");
    const overview = source("src/app/api/v1/admin/rules/deficit/route.ts");
    expect(rules).not.toContain('status: "ACTIVE"');
    expect(overview).not.toContain("overview.definition.status");
  });

  test("migration audits legacy RuleDefinition markers before removing the dead column", () => {
    const migration = source("prisma/migrations/20260906_150000_archive_lifecycle_integrity/migration.sql");
    expect(migration).toContain("RULE_DEFINITION_STATE_NORMALIZED");
    expect(migration).toContain('ALTER TABLE "RuleDefinition" DROP COLUMN IF EXISTS "status"');
  });

  test("Policy archive and reactivate are serialized, reasoned and audited", () => {
    for (const action of ["archive", "reactivate"] as const) {
      const route = source(`src/app/api/v1/admin/policies/[id]/${action}/route.ts`);
      const tx = route.indexOf("db.$transaction");
      const lock = route.indexOf("await lockPolicyMutation", tx);
      const update = route.indexOf("await tx.policy.update", lock);
      const audit = route.indexOf("await appendAudit", update);
      expect(route).toContain("reasonSchema");
      expect(tx).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(tx);
      expect(update).toBeGreaterThan(lock);
      expect(audit).toBeGreaterThan(update);
    }
  });

  test("publishing an existing policy takes the same mutex and deliberately reactivates it", () => {
    const route = source("src/app/api/v1/admin/policies/route.ts");
    const existing = route.indexOf("if (existing)");
    const lock = route.indexOf("await lockPolicyMutation", existing);
    const version = route.indexOf("await tx.policyVersion.create", lock);
    const update = route.indexOf("await tx.policy.update", version);
    expect(lock).toBeGreaterThan(existing);
    expect(version).toBeGreaterThan(lock);
    expect(update).toBeGreaterThan(version);
    expect(route.slice(update, update + 500)).toContain('status: "ACTIVE"');
  });

  test("registration remains ACTIVE-policy-only and Admin UI exposes archive/reactivate with reasons", () => {
    const publicPolicies = source("src/app/api/v1/auth/policies/route.ts");
    expect(publicPolicies).toContain('status: "ACTIVE"');

    const settings = source("src/components/app/admin/settings.tsx");
    expect(settings).toContain("<ConfirmDialog");
    expect(settings).toContain('action: "ARCHIVE" | "REACTIVATE"');
    expect(settings).toContain('requireReason');
    expect(settings).toContain('"archive" : "reactivate"');
  });
});
