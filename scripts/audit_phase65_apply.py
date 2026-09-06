from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrences, found {actual}: {old!r}")
    p.write_text(text.replace(old, new, count))

replace(
    "prisma/schema.prisma",
    '  status           String    @default("DRAFT") // DRAFT | ACTIVE | SCHEDULED | HISTORICAL\n',
    '  status           String    @default("DRAFT") // DRAFT | ACTIVE | HISTORICAL\n',
)
replace(
    "src/lib/domain/rules/deficit-rules.ts",
    '    if (candidate.status !== "DRAFT" && candidate.status !== "SCHEDULED") {\n      throw new ApiError(CODES.RESOURCE_CHANGED, "Only a draft or scheduled rule version can be activated.", 409);\n    }\n',
    '    if (candidate.status !== "DRAFT") {\n      throw new ApiError(CODES.RESOURCE_CHANGED, "Only a draft rule version can be activated.", 409);\n    }\n',
)

migration = Path("prisma/migrations/20260906_140000_rule_version_state_integrity/migration.sql")
migration.parent.mkdir(parents=True, exist_ok=False)
migration.write_text('''-- Phase 65 — persisted RuleVersion state contract integrity.
-- Runtime has never scheduled rule activation. Preserve any legacy row as a
-- draft candidate instead of pretending a scheduler will activate it.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase65-rule-state-' || rv."id",
  rd."institutionId",
  'SYSTEM',
  'RULE_VERSION_STATE_NORMALIZED',
  'RULE_VERSION',
  rv."id",
  CURRENT_TIMESTAMP,
  'Normalized an unreachable SCHEDULED rule state; rule scheduling is not implemented.',
  'status=SCHEDULED',
  'status=DRAFT'
FROM "RuleVersion" rv
JOIN "RuleDefinition" rd ON rd."id" = rv."ruleDefinitionId"
WHERE rv."status" = 'SCHEDULED'
ON CONFLICT ("id") DO NOTHING;

UPDATE "RuleVersion"
SET "status" = 'DRAFT'
WHERE "status" = 'SCHEDULED';
''')

unit = Path("tests/unit/rule-version-state-source.test.ts")
unit.write_text('''import { describe, expect, test } from "bun:test";
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
    expect(migration).toContain("WHERE \"status\" = 'SCHEDULED'");
  });
});
''')

if "SCHEDULED" in Path("src/lib/domain/rules/deficit-rules.ts").read_text():
    raise SystemExit("dead SCHEDULED rule activation contract remains")
