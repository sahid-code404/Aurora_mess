import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("final state contract closure", () => {
  test("FormulaDefinition exposes no dead archive lifecycle", () => {
    const schema = source("prisma/schema.prisma");
    const start = schema.indexOf("model FormulaDefinition {");
    const end = schema.indexOf("model FormulaVersion {", start);
    const model = schema.slice(start, end);

    expect(model).not.toContain("status");
    expect(model).not.toContain("archivedAt");

    const migration = source("prisma/migrations/20260906_160000_final_state_contract_closure/migration.sql");
    expect(migration).toContain("FORMULA_DEFINITION_STATE_NORMALIZED");
    expect(migration).toContain('DROP COLUMN IF EXISTS "status"');
    expect(migration).toContain('DROP COLUMN IF EXISTS "archivedAt"');
  });

  test("period variable registry resolves formula versions by effective window, not active pointer", () => {
    const registry = source("src/lib/domain/formula/registry.ts");
    expect(registry).toContain("selectFormulaVersionAt(def.versions, bounds.startAt)");
    expect(registry).toContain("formulaDefsForPeriod");
    expect(registry).not.toContain('versions: {\n          where: { active: true },');
  });

  test("formula mutation revalidates dependency graph under the Institution billing mutex", () => {
    const versions = source("src/lib/domain/formula/versions.ts");
    const transaction = versions.indexOf("db.$transaction(async (tx) =>");
    const lock = versions.indexOf("await lockInstitutionFinancialMutation(tx, input.institutionId)", transaction);
    const periodGuard = versions.indexOf("await assertFormulaInputPeriodMutable", lock);
    const lockedDag = versions.indexOf("const lockedDag = await buildFormulaDagForPeriod", periodGuard);
    const validate = versions.indexOf("lockedDag.validateNoCycles", lockedDag);
    const create = versions.indexOf("await tx.formulaVersion.create", validate);

    expect(transaction).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(transaction);
    expect(periodGuard).toBeGreaterThan(lock);
    expect(lockedDag).toBeGreaterThan(periodGuard);
    expect(validate).toBeGreaterThan(lockedDag);
    expect(create).toBeGreaterThan(validate);
  });

  test("custom-variable value mutation waits for billing and checks frozen state before write", () => {
    const custom = source("src/lib/domain/formula/custom-variables.ts");
    const start = custom.indexOf("export async function setCustomVariableValue");
    const end = custom.indexOf("export async function archiveCustomVariable", start);
    const block = custom.slice(start, end);
    const transaction = block.indexOf("db.$transaction(async (tx) =>");
    const lock = block.indexOf("await lockInstitutionFinancialMutation", transaction);
    const guard = block.indexOf("await assertFormulaInputPeriodMutable", lock);
    const defRead = block.indexOf("await tx.variableDefinition.findFirst", guard);
    const write = Math.min(
      ...[block.indexOf("await tx.customVariableValue.update", defRead), block.indexOf("await tx.customVariableValue.create", defRead)].filter((n) => n >= 0)
    );

    expect(lock).toBeGreaterThan(transaction);
    expect(guard).toBeGreaterThan(lock);
    expect(defRead).toBeGreaterThan(guard);
    expect(write).toBeGreaterThan(defRead);
  });

  test("custom-variable archive is serialized with formula configuration and audited in the same transaction", () => {
    const custom = source("src/lib/domain/formula/custom-variables.ts");
    const start = custom.indexOf("export async function archiveCustomVariable");
    const end = custom.indexOf("export async function togglePinVariable", start);
    const block = custom.slice(start, end);
    const transaction = block.indexOf("db.$transaction(async (tx) =>");
    const lock = block.indexOf("await lockInstitutionFinancialMutation", transaction);
    const defRead = block.indexOf("await tx.variableDefinition.findFirst", lock);
    const dependencyRead = block.indexOf("await tx.formulaDefinition.findMany", defRead);
    const update = block.indexOf("await tx.variableDefinition.update", dependencyRead);
    const audit = block.indexOf("await appendAudit", update);

    expect(lock).toBeGreaterThan(transaction);
    expect(defRead).toBeGreaterThan(lock);
    expect(dependencyRead).toBeGreaterThan(defRead);
    expect(update).toBeGreaterThan(dependencyRead);
    expect(audit).toBeGreaterThan(update);
  });

  test("archived variables remain readable for billing periods that predate the archive boundary", () => {
    const provider = source("src/lib/domain/formula/providers/custom.ts");
    expect(provider).toContain("{ archivedAt: { gt: bounds.startAt } }");
  });

  test("BOOLEAN custom variables persist their actual boolean column", () => {
    const custom = source("src/lib/domain/formula/custom-variables.ts");
    expect(custom).toContain("valueBoolean: isBoolean ? input.initialValue === 1 : null");
    expect(custom).toContain("valueBoolean: isBoolean ? input.value === 1 : null");
    expect(custom).toContain("Boolean variables use 0 (false) or 1 (true).");
  });

  test("BillingPeriod CLOSING is generationState only and meal freeze uses lockAt", () => {
    const billing = source("src/lib/domain/billing.ts");
    expect(billing).not.toContain('period.status === "CLOSING"');
    expect(billing).toContain('generationState === "CLOSING"');
    expect(billing).toContain('{ mealInstance: { lockAt: { lte: now } } }');
    expect(billing).not.toContain('{ mealInstance: { cutoffAt: { lte: now } } }');
  });
});
