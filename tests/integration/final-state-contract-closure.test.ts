import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import {
  createCustomVariable,
  setCustomVariableValue,
} from "@/lib/domain/formula/custom-variables";
import { resolveCustomVariables } from "@/lib/domain/formula/providers/custom";
import { periodBounds } from "@/lib/domain/formula/period-variables";

const prefix = "phase67-final-state-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const institution = await db.institution.create({
    data: {
      name: unique("institution"),
      timezone: "Asia/Kolkata",
      settings: { create: {} },
    },
  });
  const variable = await db.variableDefinition.create({
    data: {
      institutionId: institution.id,
      key: `kitchen_staff_salary_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      displayName: "Kitchen staff salary",
      description: "Phase 67 formula-input race fixture",
      category: "CUSTOM",
      valueType: "MONEY",
      unit: "INR",
      scope: "BILLING_PERIOD",
      frequency: "MONTHLY",
    },
  });
  const value = await db.customVariableValue.create({
    data: {
      variableDefinitionId: variable.id,
      valueMinor: 100_000,
      effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
      billingPeriodKey: "2026-09",
    },
  });
  const period = await db.billingPeriod.create({
    data: {
      institutionId: institution.id,
      year: 2026,
      month: 9,
      status: "OPEN",
    },
  });
  return { institution, variable, value, period };
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    const definitions = await db.variableDefinition.findMany({
      where: { institutionId: { in: ids } },
      select: { id: true },
    });
    const definitionIds = definitions.map((row) => row.id);
    if (definitionIds.length > 0) {
      await db.customVariableValue.deleteMany({ where: { variableDefinitionId: { in: definitionIds } } });
      await db.variableDefinition.deleteMany({ where: { id: { in: definitionIds } } });
    }
    await db.auditEvent.deleteMany({ where: { institutionId: { in: ids } } });
    await db.billingPeriod.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("final formula-input and billing serialization", () => {
  test("custom-variable edit waits behind billing and re-checks the period after the lock", async () => {
    const { institution, variable, value, period } = await fixture();
    const billingLocked = deferred();
    const releaseBilling = deferred();
    let mutationSettled = false;

    const billing = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await tx.billingPeriod.update({
        where: { id: period.id },
        data: { status: "BILLED", billedAt: new Date("2026-10-05T00:00:00.000Z") },
      });
      billingLocked.resolve();
      await releaseBilling.promise;
    });

    await billingLocked.promise;

    const mutation = setCustomVariableValue({
      institutionId: institution.id,
      adminUserId: "phase67-admin",
      variableDefinitionId: variable.id,
      billingPeriodKey: "2026-09",
      value: 250_000,
    })
      .then(() => null)
      .catch((error: unknown) => error)
      .finally(() => {
        mutationSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationSettled).toBe(false);

    releaseBilling.resolve();
    await billing;
    const error = await mutation;
    expect(error).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });

    const unchanged = await db.customVariableValue.findUniqueOrThrow({ where: { id: value.id } });
    expect(unchanged.valueMinor).toBe(100_000);
  });

  test("REOPENED periods remain frozen for direct formula-input rewrites", async () => {
    const { institution, variable, period } = await fixture();
    await db.billingPeriod.update({ where: { id: period.id }, data: { status: "REOPENED" } });

    const error = await setCustomVariableValue({
      institutionId: institution.id,
      adminUserId: "phase67-admin",
      variableDefinitionId: variable.id,
      billingPeriodKey: "2026-09",
      value: 300_000,
    })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });
  });

  test("an archived custom variable remains resolvable for periods before archivedAt", async () => {
    const { institution, variable } = await fixture();
    await db.variableDefinition.update({
      where: { id: variable.id },
      data: { archivedAt: new Date("2026-10-15T00:00:00.000Z") },
    });

    const september = await resolveCustomVariables(
      institution.id,
      periodBounds(2026, 9, institution.timezone),
      undefined,
      db
    );
    expect(september[variable.key]).toBe(100_000);

    const november = await resolveCustomVariables(
      institution.id,
      periodBounds(2026, 11, institution.timezone),
      undefined,
      db
    );
    expect(november[variable.key]).toBeUndefined();
  });

  test("BOOLEAN variables persist and update the boolean column truthfully", async () => {
    const institution = await db.institution.create({
      data: {
        name: unique("institution"),
        timezone: "Asia/Kolkata",
        settings: { create: {} },
      },
    });

    const created = await createCustomVariable({
      institutionId: institution.id,
      adminUserId: "phase67-admin",
      name: "Kitchen subsidy enabled",
      key: `kitchen_subsidy_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      valueType: "BOOLEAN",
      unit: "NONE",
      initialValue: 1,
      effectivePeriod: "2026-11",
    });

    const initial = await db.customVariableValue.findUniqueOrThrow({
      where: { id: created.initialValue.id },
    });
    expect(initial.valueBoolean).toBe(true);
    expect(initial.valueNumber).toBeNull();

    await setCustomVariableValue({
      institutionId: institution.id,
      adminUserId: "phase67-admin",
      variableDefinitionId: created.definition.id,
      billingPeriodKey: "2026-12",
      value: 0,
    });

    const updated = await db.customVariableValue.findFirstOrThrow({
      where: { variableDefinitionId: created.definition.id, billingPeriodKey: "2026-12" },
    });
    expect(updated.valueBoolean).toBe(false);
    expect(updated.valueNumber).toBeNull();
  });
});
