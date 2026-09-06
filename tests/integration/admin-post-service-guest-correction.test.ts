import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import {
  applyAdminGuestMealQuantityCorrection,
  assertGuestMealCorrectionPeriodMutable,
} from "@/lib/domain/guest-meal-admin-correction";

const prefix = "guest-post-service-correction-";

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
    data: { name: unique("institution"), timezone: "Asia/Kolkata" },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@guest-correction.test`,
      passwordHash: "test-only",
    },
  });
  const definition = await db.mealDefinition.create({
    data: { institutionId: institution.id, name: unique("meal") },
  });
  const version = await db.mealDefinitionVersion.create({
    data: { mealDefinitionId: definition.id, version: 1, configSnapshotJson: "{}" },
  });
  const lockAt = new Date("2026-09-05T12:00:00.000Z");
  const instance = await db.mealInstance.create({
    data: {
      institutionId: institution.id,
      mealDefinitionId: definition.id,
      mealDefinitionVersionId: version.id,
      serviceDate: new Date("2026-09-05T00:00:00.000Z"),
      serviceStartAt: new Date("2026-09-05T12:30:00.000Z"),
      serviceEndAt: new Date("2026-09-05T14:00:00.000Z"),
      cutoffAt: lockAt,
      lockAt,
      status: "COMPLETED",
    },
  });
  return { institution, resident, definition, instance, lockAt };
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    await db.guestMealRequest.deleteMany({ where: { institutionId: { in: ids } } });
    await db.residentMeal.deleteMany({ where: { institutionId: { in: ids } } });
    await db.mealInstance.deleteMany({ where: { institutionId: { in: ids } } });
    const definitions = await db.mealDefinition.findMany({
      where: { institutionId: { in: ids } },
      select: { id: true },
    });
    const definitionIds = definitions.map((row) => row.id);
    if (definitionIds.length > 0) {
      await db.mealDefinitionVersion.deleteMany({ where: { mealDefinitionId: { in: definitionIds } } });
      await db.mealDefinition.deleteMany({ where: { id: { in: definitionIds } } });
    }
    await db.billingSnapshot.deleteMany({ where: { institutionId: { in: ids } } });
    await db.bill.deleteMany({ where: { institutionId: { in: ids } } });
    await db.billingPeriod.deleteMany({ where: { institutionId: { in: ids } } });
    await db.userStatusHistory.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.session.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.userProfile.deleteMany({ where: { users: { some: { institutionId: { in: ids } } } } });
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("Admin post-service guest corrections", () => {
  test("corrects a CONSUMED guest quantity without moving the lifecycle backwards", async () => {
    const { institution, resident, instance, lockAt } = await fixture();
    const row = await db.guestMealRequest.create({
      data: {
        institutionId: institution.id,
        hostResidentId: resident.id,
        mealInstanceId: instance.id,
        quantity: 3,
        unitPriceMinor: 5500,
        totalPriceMinor: 16500,
        status: "CONSUMED",
        lockedAt: lockAt,
      },
    });

    const result = await db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await assertGuestMealCorrectionPeriodMutable(tx, institution.id, instance.serviceDate);
      return applyAdminGuestMealQuantityCorrection({
        client: tx,
        institutionId: institution.id,
        residentId: resident.id,
        mealInstanceId: instance.id,
        targetQuantity: 1,
        unitPriceMinor: 5500,
        lockAt,
        serviceEnded: true,
      });
    });

    expect(result.currentTotal).toBe(3);
    expect(result.status).toBe("CONSUMED");
    const corrected = await db.guestMealRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(corrected.status).toBe("CONSUMED");
    expect(corrected.quantity).toBe(1);
    expect(corrected.totalPriceMinor).toBe(5500);
    expect(corrected.note).toContain("|post-service");
  });

  test("post-service correction to zero preserves CONSUMED terminal history", async () => {
    const { institution, resident, instance, lockAt } = await fixture();
    const row = await db.guestMealRequest.create({
      data: {
        institutionId: institution.id,
        hostResidentId: resident.id,
        mealInstanceId: instance.id,
        quantity: 2,
        unitPriceMinor: 5500,
        totalPriceMinor: 11000,
        status: "CONSUMED",
        lockedAt: lockAt,
      },
    });

    await db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await applyAdminGuestMealQuantityCorrection({
        client: tx,
        institutionId: institution.id,
        residentId: resident.id,
        mealInstanceId: instance.id,
        targetQuantity: 0,
        unitPriceMinor: 5500,
        lockAt,
        serviceEnded: true,
      });
    });

    const corrected = await db.guestMealRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(corrected.status).toBe("CONSUMED");
    expect(corrected.quantity).toBe(0);
    expect(corrected.totalPriceMinor).toBe(0);
  });

  test("can add a missing consumed guest after service while the month is unbilled", async () => {
    const { institution, resident, instance, lockAt } = await fixture();

    const result = await db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await assertGuestMealCorrectionPeriodMutable(tx, institution.id, instance.serviceDate);
      return applyAdminGuestMealQuantityCorrection({
        client: tx,
        institutionId: institution.id,
        residentId: resident.id,
        mealInstanceId: instance.id,
        targetQuantity: 2,
        unitPriceMinor: 5500,
        lockAt,
        serviceEnded: true,
      });
    });

    const created = await db.guestMealRequest.findUniqueOrThrow({ where: { id: result.targetRecordId! } });
    expect(created.status).toBe("CONSUMED");
    expect(created.quantity).toBe(2);
    expect(created.totalPriceMinor).toBe(11000);
  });

  test("finalized billing freezes post-service guest corrections", async () => {
    const { institution, instance } = await fixture();
    await db.billingPeriod.create({
      data: {
        institutionId: institution.id,
        year: 2026,
        month: 9,
        status: "BILLED",
        generationState: "COMPLETED",
      },
    });

    const outcome = await db
      .$transaction(async (tx) => {
        await lockInstitutionFinancialMutation(tx, institution.id);
        await assertGuestMealCorrectionPeriodMutable(tx, institution.id, instance.serviceDate);
      })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
    }
  });

  test("a billing claim that wins the Institution mutex blocks a waiting correction", async () => {
    const { institution, instance } = await fixture();
    const period = await db.billingPeriod.create({
      data: { institutionId: institution.id, year: 2026, month: 9, status: "OPEN" },
    });
    const billingLocked = deferred();
    const releaseBilling = deferred();
    let correctionPassed = false;

    const billing = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      await tx.billingPeriod.update({ where: { id: period.id }, data: { generationState: "CLOSING" } });
      billingLocked.resolve();
      await releaseBilling.promise;
    });

    await billingLocked.promise;

    const correction = db
      .$transaction(async (tx) => {
        await lockInstitutionFinancialMutation(tx, institution.id);
        await assertGuestMealCorrectionPeriodMutable(tx, institution.id, instance.serviceDate);
        correctionPassed = true;
      })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(correctionPassed).toBe(false);

    releaseBilling.resolve();
    await billing;
    const outcome = await correction;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
  });
});
