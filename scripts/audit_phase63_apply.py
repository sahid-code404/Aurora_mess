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
    '  startsAt         DateTime  @default(now())\n  expiresAt        DateTime?\n  approvedByUserId String\n',
    '  startsAt         DateTime  @default(now())\n  expiresAt        DateTime\n  approvedByUserId String\n',
)

replace(
    "src/lib/domain/policy-exemption.ts",
    '    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],\n',
    '    expiresAt: { gt: now },\n',
)
replace(
    "src/lib/domain/policy-exemption.ts",
    '      (exemption.expiresAt === null || exemption.expiresAt.getTime() > now.getTime());\n',
    '      exemption.expiresAt.getTime() > now.getTime();\n',
)
replace(
    "src/lib/domain/policy-exemption.ts",
    '        beforeSummary: exemption.expiresAt ? `until ${exemption.expiresAt.toISOString()}` : "legacy open-ended exemption",\n',
    '        beforeSummary: `until ${exemption.expiresAt.toISOString()}`,\n',
)
replace(
    "src/lib/domain/policy-exemption.ts",
    '        afterSummary: `until ${created.expiresAt!.toISOString()}`,\n',
    '        afterSummary: `until ${created.expiresAt.toISOString()}`,\n',
)
replace(
    "src/lib/domain/policy-exemption.ts",
    '          expiresAt: created.expiresAt!.toISOString(),\n',
    '          expiresAt: created.expiresAt.toISOString(),\n',
)

replace(
    "src/lib/domain/funds.ts",
    '        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],\n',
    '        expiresAt: { gt: new Date() },\n',
)
replace(
    "src/lib/domain/funds.ts",
    '    graceUntilIso = activeExemption.expiresAt?.toISOString() ?? null;\n',
    '    graceUntilIso = activeExemption.expiresAt.toISOString();\n',
)

replace(
    "src/app/api/v1/admin/funds/route.ts",
    '        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],\n',
    '        expiresAt: { gt: new Date() },\n',
)
replace(
    "src/app/api/v1/admin/funds/route.ts",
    '        expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,\n',
    '        expiresAt: e.expiresAt.toISOString(),\n',
)

route = Path("src/app/api/v1/admin/policy-exemptions/route.ts")
text = route.read_text()
old_block = '''      startsAt: { lte: now },
      // Legacy null-expiry rows remain visible so Admin can explicitly cancel
      // them; all new writes are finite through the POST contract below.
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
'''
new_block = '''      startsAt: { lte: now },
      expiresAt: { gt: now },
'''
if text.count(old_block) != 1:
    raise SystemExit("policy exemption GET legacy block not found exactly once")
text = text.replace(old_block, new_block, 1)
old = '      expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,\n      legacyOpenEnded: e.expiresAt === null,\n'
if text.count(old) != 1:
    raise SystemExit("policy exemption GET legacy serialization not found exactly once")
text = text.replace(old, '      expiresAt: e.expiresAt.toISOString(),\n', 1)
old = '      expiresAt: exemption.expiresAt!.toISOString(),\n      legacyOpenEnded: false,\n'
if text.count(old) != 1:
    raise SystemExit("policy exemption POST legacy serialization not found exactly once")
text = text.replace(old, '      expiresAt: exemption.expiresAt.toISOString(),\n', 1)
route.write_text(text)

replace(
    "src/lib/domain/billing.ts",
    '        expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,\n',
    '        expiresAt: e.expiresAt.toISOString(),\n',
)
replace(
    "src/components/app/admin/_shared/types.ts",
    '  expiresAt: string | null;\n  approvedByUserId: string;\n  createdAt: string;\n}\n',
    '  expiresAt: string;\n  approvedByUserId: string;\n  createdAt: string;\n}\n',
)
replace(
    "src/components/app/admin/funds.tsx",
    '                    {ex.expiresAt ? `Until ${fmtDate(ex.expiresAt)}` : "Until cancelled"} · granted {fmtDate(ex.createdAt)}\n',
    '                    Until {fmtDate(ex.expiresAt)} · granted {fmtDate(ex.createdAt)}\n',
)

migration = Path("prisma/migrations/20260906_120000_finite_policy_exemptions/migration.sql")
migration.parent.mkdir(parents=True, exist_ok=False)
migration.write_text('''-- Phase 63 — enforce the finite deficit-policy exemption contract.
-- Legacy open-ended exemptions are retained as history, audited, and ended
-- at migration time before the persistence column becomes NOT NULL.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase63-finite-' || "id",
  "institutionId",
  'SYSTEM',
  'POLICY_EXEMPTION_LEGACY_ENDED',
  'POLICY_EXEMPTION',
  "id",
  CURRENT_TIMESTAMP,
  'Legacy open-ended exemptions are invalid under the finite exemption lifecycle.',
  'legacy open-ended exemption',
  'ended during finite exemption migration'
FROM "PolicyExemption"
WHERE "expiresAt" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "PolicyExemption"
SET "expiresAt" = CURRENT_TIMESTAMP
WHERE "expiresAt" IS NULL;

ALTER TABLE "PolicyExemption" ALTER COLUMN "expiresAt" SET NOT NULL;
''')

source_test = Path("tests/unit/policy-exemption-finite-source.test.ts")
source_test.write_text('''import { describe, expect, test } from "bun:test";
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
''')

integration = Path("tests/integration/policy-exemption-finite-persistence.test.ts")
integration.write_text('''import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";

afterAll(async () => {
  await db.$disconnect();
});

describe("finite policy exemption database contract", () => {
  test("PostgreSQL requires every policy exemption to have an expiry", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PolicyExemption' AND column_name = 'expiresAt'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("NO");
  });
});
''')

# Fail closed on the four policy-exemption readers only. Announcement expiry is
# intentionally nullable and is a separate lifecycle.
for path in [
    "src/lib/domain/policy-exemption.ts",
    "src/lib/domain/funds.ts",
    "src/app/api/v1/admin/funds/route.ts",
    "src/app/api/v1/admin/policy-exemptions/route.ts",
]:
    text = Path(path).read_text()
    if "OR: [{ expiresAt: null }" in text or "legacyOpenEnded" in text:
        raise SystemExit(f"open-ended policy exemption contract remains in {path}")

if "Until cancelled" in Path("src/components/app/admin/funds.tsx").read_text():
    raise SystemExit("open-ended policy exemption UI label remains")
