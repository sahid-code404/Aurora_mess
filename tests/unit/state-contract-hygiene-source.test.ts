import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("persisted state contract hygiene", () => {
  test("StoredFile no longer claims an unimplemented malware scan lifecycle", () => {
    const schema = source("prisma/schema.prisma");
    const storage = source("src/lib/storage.ts");
    const migration = source("prisma/migrations/20260906_110000_state_contract_hygiene/migration.sql");

    expect(schema).not.toContain("scanStatus");
    expect(storage).not.toContain("scanStatus");
    expect(migration).toContain('ALTER TABLE "StoredFile" DROP COLUMN IF EXISTS "scanStatus"');
  });

  test("Expense exposes only its real review lifecycle", () => {
    const schema = source("prisma/schema.prisma");
    const route = source("src/app/api/v1/admin/expenses/route.ts");
    const migration = source("prisma/migrations/20260906_110000_state_contract_hygiene/migration.sql");

    expect(schema).toContain("// PENDING | APPROVED | REJECTED | VOIDED");
    expect(route).toContain('["PENDING", "APPROVED", "REJECTED", "VOIDED"]');
    expect(route).not.toContain('["DRAFT", "PENDING"');
    expect(migration).toContain('WHERE "status" = 'DRAFT'');
  });

  test("Formula UI and persistence describe the effective-window lifecycle actually implemented", () => {
    const schema = source("prisma/schema.prisma");
    const ui = source("src/components/app/admin/formulas.tsx");
    const versions = source("src/lib/domain/formula/versions.ts");

    expect(schema).toContain('// ACTIVE | ARCHIVED');
    expect(schema).toContain('// ACTIVE | HISTORICAL');
    expect(ui).not.toContain('formulaFilter === "DRAFT"');
    expect(ui).not.toContain('{ value: "DRAFT", label: "Draft" }');
    expect(versions).toContain('status: "ACTIVE"');
    expect(versions).toContain('status: "HISTORICAL"');
    expect(versions).toContain("effectiveFrom");
  });
});
