import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("formula status badge runtime contract", () => {
  test("formula Admin API exposes derived ACTIVE status without persisted definition lifecycle", () => {
    const route = source("src/app/api/v1/admin/formulas/route.ts");
    const schema = source("prisma/schema.prisma");
    const start = schema.indexOf("model FormulaDefinition {");
    const end = schema.indexOf("model FormulaVersion {", start);
    const formulaDefinitionModel = schema.slice(start, end);

    expect(route).toContain('status: "ACTIVE" as const');
    expect(route.match(/status: "ACTIVE" as const/g)?.length).toBeGreaterThanOrEqual(2);
    expect(formulaDefinitionModel).not.toContain("status");
    expect(formulaDefinitionModel).not.toContain("archivedAt");
  });

  test("StatusBadge cannot throw when a read model supplies a missing status", () => {
    const badge = source("src/components/glass/StatusBadge.tsx");

    expect(badge).toContain("status?: string | null");
    expect(badge).toContain('typeof status === "string" ? status.trim() : ""');
    expect(badge).toContain('(raw || "UNKNOWN")');
    expect(badge).toContain('UNKNOWN: "Unknown"');
    expect(badge).not.toContain("return status.trim().toUpperCase()");
  });
});
