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
    '  status                  String    @default("OPEN") // OPEN | CLOSING | BILLED | REOPENED\n',
    '  status                  String    @default("OPEN") // OPEN | BILLED | REOPENED\n',
)
replace(
    "prisma/schema.prisma",
    '  generationState         String? // CLOSING | GENERATING | COMPLETED | FAILED\n  generationError         String?\n',
    '  generationState         String? // CLOSING | COMPLETED; failed transactions roll back to null\n',
)
replace(
    "src/lib/domain/billing.ts",
    '      if (current?.generationState === "CLOSING" || current?.generationState === "GENERATING") {\n',
    '      if (current?.generationState === "CLOSING") {\n',
)
replace(
    "src/lib/domain/billing.ts",
    '        generationState: "COMPLETED",\n        generationError: null,\n',
    '        generationState: "COMPLETED",\n',
)
replace(
    "src/lib/domain/expense-period.ts",
    '    period.generationState === "CLOSING" ||\n    period.generationState === "GENERATING";\n',
    '    period.generationState === "CLOSING";\n',
)
replace(
    "src/components/app/admin/_shared/types.ts",
    '  status: "OPEN" | "CLOSING" | "BILLED" | "REOPENED" | string;\n',
    '  status: "OPEN" | "BILLED" | "REOPENED" | string;\n',
)

migration = Path("prisma/migrations/20260906_130000_billing_generation_state_integrity/migration.sql")
migration.parent.mkdir(parents=True, exist_ok=False)
migration.write_text('''-- Phase 64 — make BillingPeriod persistence match the transactional billing lifecycle.
-- Runtime keeps status OPEN while generationState=CLOSING owns the transaction.
-- A failed run rolls back, so persisted CLOSING/GENERATING/FAILED on an OPEN
-- period can only be legacy/stale state after deployment. Preserve evidence in
-- AuditEvent before normalizing it.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase64-billing-state-' || "id",
  "institutionId",
  'SYSTEM',
  'BILLING_GENERATION_STATE_NORMALIZED',
  'BILLING_PERIOD',
  "id",
  CURRENT_TIMESTAMP,
  'Normalized a legacy billing period/generation state that cannot survive the current transactional lifecycle.',
  'status=' || COALESCE("status", 'null') || '; generationState=' || COALESCE("generationState", 'null') || '; generationError=' || COALESCE("generationError", 'null'),
  CASE
    WHEN "status" = 'CLOSING' AND EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = "BillingPeriod"."id")
      THEN 'status=BILLED; generationState=COMPLETED'
    WHEN "status" = 'BILLED'
      THEN 'status=BILLED; generationState=COMPLETED'
    WHEN "status" = 'REOPENED'
      THEN 'status=REOPENED; generationState=null'
    ELSE 'status=OPEN; generationState=null'
  END
FROM "BillingPeriod"
WHERE "status" = 'CLOSING'
   OR "generationState" IN ('GENERATING', 'FAILED')
   OR ("status" = 'OPEN' AND "generationState" = 'CLOSING')
   OR "generationError" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "BillingPeriod" p
SET
  "status" = 'BILLED',
  "generationState" = 'COMPLETED',
  "closedAt" = COALESCE(p."closedAt", p."billedAt", CURRENT_TIMESTAMP),
  "billedAt" = COALESCE(p."billedAt", p."closedAt", CURRENT_TIMESTAMP)
WHERE p."status" = 'CLOSING'
  AND EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = p."id");

UPDATE "BillingPeriod"
SET
  "status" = CASE WHEN "status" = 'CLOSING' THEN 'OPEN' ELSE "status" END,
  "generationState" = CASE
    WHEN "status" = 'BILLED' THEN 'COMPLETED'
    WHEN "status" = 'REOPENED' THEN NULL
    ELSE NULL
  END
WHERE "status" = 'CLOSING'
   OR "generationState" IN ('CLOSING', 'GENERATING', 'FAILED')
   OR "generationError" IS NOT NULL;

UPDATE "BillingPeriod" SET "generationState" = 'COMPLETED' WHERE "status" = 'BILLED';
UPDATE "BillingPeriod" SET "generationState" = NULL WHERE "status" = 'REOPENED';

ALTER TABLE "BillingPeriod" DROP COLUMN IF EXISTS "generationError";
''')

unit = Path("tests/unit/billing-generation-state-source.test.ts")
unit.write_text('''import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("billing generation persistence contract", () => {
  test("period status and generation state expose only committed runtime states", () => {
    const schema = source("prisma/schema.prisma");
    const billing = source("src/lib/domain/billing.ts");
    const types = source("src/components/app/admin/_shared/types.ts");
    const expensePeriod = source("src/lib/domain/expense-period.ts");
    const start = schema.indexOf("model BillingPeriod {");
    const end = schema.indexOf("model BillingSnapshot", start);
    const model = schema.slice(start, end);

    expect(model).toContain("// OPEN | BILLED | REOPENED");
    expect(model).toContain("// CLOSING | COMPLETED; failed transactions roll back to null");
    expect(model).not.toContain("generationError");
    expect(model).not.toContain("GENERATING");
    expect(model).not.toContain("FAILED");
    expect(types).not.toContain('"OPEN" | "CLOSING" | "BILLED"');
    expect(billing).not.toContain('generationState === "GENERATING"');
    expect(billing).not.toContain("generationError:");
    expect(expensePeriod).not.toContain('generationState === "GENERATING"');
  });

  test("billing still claims generation atomically and commits canonical terminal state", () => {
    const billing = source("src/lib/domain/billing.ts");
    expect(billing).toContain('status: "OPEN", generationState: null');
    expect(billing).toContain('data: { generationState: "CLOSING" }');
    expect(billing).toContain('status: "BILLED"');
    expect(billing).toContain('generationState: "COMPLETED"');
    expect(billing).toContain('data: { status: "REOPENED", generationState: null }');
  });

  test("migration audits legacy states and preserves periods with generated bills", () => {
    const migration = source("prisma/migrations/20260906_130000_billing_generation_state_integrity/migration.sql");
    expect(migration).toContain("BILLING_GENERATION_STATE_NORMALIZED");
    expect(migration).toContain('EXISTS (SELECT 1 FROM "Bill"');
    expect(migration).toContain("THEN 'status=BILLED; generationState=COMPLETED'");
    expect(migration).toContain('DROP COLUMN IF EXISTS "generationError"');
  });
});
''')

integration = Path("tests/integration/billing-generation-state-persistence.test.ts")
integration.write_text('''import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";

afterAll(async () => {
  await db.$disconnect();
});

describe("billing generation database contract", () => {
  test("generationError was removed and period rows use canonical states", async () => {
    const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BillingPeriod' AND column_name = 'generationError'`
    );
    expect(cols).toHaveLength(0);

    const invalid = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "BillingPeriod" WHERE "status" NOT IN ('OPEN','BILLED','REOPENED') OR ("generationState" IS NOT NULL AND "generationState" NOT IN ('CLOSING','COMPLETED')) OR ("status" = 'BILLED' AND "generationState" <> 'COMPLETED') OR ("status" = 'REOPENED' AND "generationState" IS NOT NULL)`
    );
    expect(Number(invalid[0]?.count ?? 0n)).toBe(0);
  });
});
''')

for path in ["src/lib/domain/billing.ts", "src/lib/domain/expense-period.ts", "src/components/app/admin/_shared/types.ts"]:
    text = Path(path).read_text()
    if "GENERATING" in text or 'generationState: "FAILED"' in text or "generationError" in text:
        raise SystemExit(f"dead billing generation contract remains in {path}")
