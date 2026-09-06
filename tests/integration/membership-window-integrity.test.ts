import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";
import { assertMembershipWindowPreservesBilledHistory } from "@/lib/domain/membership-window";

const prefix = "phase51-membership-";

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
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase51.test`,
      passwordHash: "phase51-test-only",
      membershipEffectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      membershipEffectiveUntil: null,
    },
  });
  const period = await db.billingPeriod.create({
    data: {
      institutionId: institution.id,
      year: 2026,
      month: 9,
      status: "BILLED",
      billedAt: new Date("2026-10-05T00:00:00.000Z"),
    },
  });
  return { institution, resident, period };
}

async function guardError(
  institutionId: string,
  before: { membershipEffectiveFrom: Date | null; membershipEffectiveUntil: Date | null },
  after: { membershipEffectiveFrom: Date | null; membershipEffectiveUntil: Date | null }
) {
  return db
    .$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institutionId);
      await assertMembershipWindowPreservesBilledHistory(
        tx,
        institutionId,
        "Asia/Kolkata",
        before,
        after
      );
    })
    .then(() => null)
    .catch((error: unknown) => error);
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    await db.billingPeriod.deleteMany({ where: { institutionId: { in: ids } } });
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("membership window closed-billing integrity", () => {
  test("rejects moving a membership start inside a billed month", async () => {
    const { institution } = await fixture();
    const error = await guardError(
      institution.id,
      {
        membershipEffectiveFrom: new Date("2026-09-05T00:00:00.000Z"),
        membershipEffectiveUntil: null,
      },
      {
        membershipEffectiveFrom: new Date("2026-09-20T00:00:00.000Z"),
        membershipEffectiveUntil: null,
      }
    );

    expect(error).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });
  });

  test("rejects clearing a start boundary that previously constrained billed history", async () => {
    const { institution } = await fixture();
    const error = await guardError(
      institution.id,
      {
        membershipEffectiveFrom: new Date("2026-09-10T00:00:00.000Z"),
        membershipEffectiveUntil: null,
      },
      { membershipEffectiveFrom: null, membershipEffectiveUntil: null }
    );

    expect(error).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });
  });

  test("rejects changing or clearing a membership end that affects a billed month", async () => {
    const { institution } = await fixture();

    for (const nextUntil of [new Date("2026-09-25T00:00:00.000Z"), null]) {
      const error = await guardError(
        institution.id,
        {
          membershipEffectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
          membershipEffectiveUntil: new Date("2026-09-15T00:00:00.000Z"),
        },
        {
          membershipEffectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
          membershipEffectiveUntil: nextUntil,
        }
      );
      expect(error).toMatchObject({ code: CODES.BILLING_PERIOD_CLOSED, status: 409 });
    }
  });

  test("allows a boundary edit that remains wholly after the billed month", async () => {
    const { institution } = await fixture();

    await expect(
      db.$transaction(async (tx) => {
        await lockInstitutionFinancialMutation(tx, institution.id);
        await assertMembershipWindowPreservesBilledHistory(
          tx,
          institution.id,
          institution.timezone,
          {
            membershipEffectiveFrom: new Date("2026-10-10T00:00:00.000Z"),
            membershipEffectiveUntil: null,
          },
          {
            membershipEffectiveFrom: new Date("2026-11-10T00:00:00.000Z"),
            membershipEffectiveUntil: null,
          }
        );
      })
    ).resolves.toBeUndefined();
  });

  test("reopening the affected billing period restores the explicit correction path", async () => {
    const { institution, period } = await fixture();
    await db.billingPeriod.update({ where: { id: period.id }, data: { status: "REOPENED" } });

    await expect(
      guardError(
        institution.id,
        {
          membershipEffectiveFrom: new Date("2026-09-05T00:00:00.000Z"),
          membershipEffectiveUntil: null,
        },
        {
          membershipEffectiveFrom: new Date("2026-09-20T00:00:00.000Z"),
          membershipEffectiveUntil: null,
        }
      )
    ).resolves.toBeNull();
  });

  test("membership mutation waits behind the institution billing mutex before taking the resident row", async () => {
    const { institution, resident } = await fixture();
    const billingLocked = deferred();
    const releaseBilling = deferred();
    let membershipInstitutionAcquired = false;
    let membershipResidentAcquired = false;

    const billing = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      billingLocked.resolve();
      await releaseBilling.promise;
    });

    await billingLocked.promise;

    const membership = db.$transaction(async (tx) => {
      await lockInstitutionFinancialMutation(tx, institution.id);
      membershipInstitutionAcquired = true;
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      membershipResidentAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(membershipInstitutionAcquired).toBe(false);
    expect(membershipResidentAcquired).toBe(false);

    releaseBilling.resolve();
    await Promise.all([billing, membership]);
    expect(membershipInstitutionAcquired).toBe(true);
    expect(membershipResidentAcquired).toBe(true);
  });
});
