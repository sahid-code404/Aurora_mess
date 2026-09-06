import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("rule version persistence contract", () => {
  test("schema exposes only the rule states the runtime actually drives", () => {
    const schema = source("prisma/schema.prisma");
    const start = schema.indexOf("model RuleVersion {");
    const end = schema.indexOf("model FormulaDefinition", start);
    const model = schema.slice(start, end);
    expect(model).toContain("// DRAFT | ACTIVE | HISTORICAL");
    expect(model).not.toContain("SCHEDULED");
  });

  test("activation accepts only a real draft candidate", () => {
    const rules = source("src/lib/domain/rules/deficit-rules.ts");
    expect(rules).toContain('candidate.status !== "DRAFT"');
    expect(rules).toContain("Only a draft rule version can be activated.");
    expect(rules).not.toContain('candidate.status !== "SCHEDULED"');
    expect(rules).not.toContain("draft or scheduled rule version");
  });

  test("migration audits and preserves legacy scheduled candidates as drafts", () => {
    const migration = source("prisma/migrations/20260906_140000_rule_version_state_integrity/migration.sql");
    expect(migration).toContain("RULE_VERSION_STATE_NORMALIZED");
    expect(migration).toContain("status=SCHEDULED");
    expect(migration).toContain("status=DRAFT");
    expect(migration).toContain('WHERE rv."status" = \'SCHEDULED\'');
  });
});
