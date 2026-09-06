import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import {
  cancelDeficitPolicyExemption,
  grantDeficitPolicyExemption,
} from "@/lib/domain/policy-exemption";

const prefix = "phase53-exemption-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

async function fixture(status = "ACTIVE") {
  const institution = await db.institution.create({
    data: { name: unique("institution"), timezone: "Asia/Kolkata", settings: { create: {} } },
  });
  const admin = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "ADMIN",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase53-admin.test`,
      passwordHash: "phase53-test-only",
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status,
      email: `${crypto.randomUUID()}@phase53-resident.test`,
      passwordHash: "phase53-test-only",
    },
  });
  return { institution, admin, resident };
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    await db.policyExemption.deleteMany({ where: { institutionId: { in: ids } } });
    await db.outboxEvent.deleteMany({ where: { institutionId: { in: ids } } });
    await db.auditEvent.deleteMany({ where: { institutionId: { in: ids } } });
    const users = await db.user.findMany({ where: { institutionId: { in: ids } }, select: { id: true } });
    const userIds = users.map((row) => row.id);
    if (userIds.length > 0) {
      await db.userStatusHistory.deleteMany({ where: { userId: { in: userIds } } });
      await db.session.deleteMany({ where: { userId: { in: userIds } } });
    }
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("deficit policy exemption lifecycle", () => {
  test("stores a finite expiry at the institution local end-of-day", async () => {
    const { institution, admin, resident } = await fixture();
    const exemption = await grantDeficitPolicyExemption({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("grant"),
      reason: "Salary settlement delay",
      expiresOn: "2026-09-10",
      now: new Date("2026-09-06T06:00:00.000Z"),
    });

    expect(exemption.expiresAt?.toISOString()).toBe("2026-09-10T18:29:59.999Z");
    expect(exemption.expiresAt).not.toBeNull();
    const audit = await db.auditEvent.findFirst({
      where: { institutionId: institution.id, entityId: exemption.id, action: "POLICY_EXEMPTION_CREATED" },
    });
    expect(audit).not.toBeNull();
  });

  test("rejects an expiry before the current institution-local date", async () => {
    const { institution, admin, resident } = await fixture();
    const error = await grantDeficitPolicyExemption({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("grant"),
      reason: "Invalid past date",
      expiresOn: "2026-09-05",
      now: new Date("2026-09-06T06:00:00.000Z"),
    }).then(() => null).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 400 });
    expect(await db.policyExemption.count({ where: { institutionId: institution.id } })).toBe(0);
  });

  test("rejects a grant when authoritative resident state is not ACTIVE", async () => {
    const { institution, admin, resident } = await fixture("INACTIVE");
    const error = await grantDeficitPolicyExemption({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("grant"),
      reason: "Should not apply",
      expiresOn: "2026-09-10",
      now: new Date("2026-09-06T06:00:00.000Z"),
    }).then(() => null).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
  });

  test("two concurrent grants serialize to exactly one active exemption", async () => {
    const { institution, admin, resident } = await fixture();
    const now = new Date("2026-09-06T06:00:00.000Z");

    const results = await Promise.allSettled([
      grantDeficitPolicyExemption({
        institutionId: institution.id,
        residentId: resident.id,
        actorUserId: admin.id,
        requestId: unique("grant-a"),
        reason: "Concurrent grant A",
        expiresOn: "2026-09-10",
        now,
      }),
      grantDeficitPolicyExemption({
        institutionId: institution.id,
        residentId: resident.id,
        actorUserId: admin.id,
        requestId: unique("grant-b"),
        reason: "Concurrent grant B",
        expiresOn: "2026-09-11",
        now,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await db.policyExemption.count({
        where: { institutionId: institution.id, residentId: resident.id, policyType: "DEFICIT_RESTRICTION" },
      })
    ).toBe(1);
  });

  test("concurrent cancellation emits one lifecycle transition and duplicate cancellation fails", async () => {
    const { institution, admin, resident } = await fixture();
    const exemption = await grantDeficitPolicyExemption({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("grant"),
      reason: "Temporary exception",
      expiresOn: "2026-09-20",
      now: new Date("2026-09-06T06:00:00.000Z"),
    });
    const cancelAt = new Date("2026-09-07T06:00:00.000Z");

    const results = await Promise.allSettled([
      cancelDeficitPolicyExemption({
        institutionId: institution.id,
        exemptionId: exemption.id,
        actorUserId: admin.id,
        requestId: unique("cancel-a"),
        reason: "No longer required",
        now: cancelAt,
      }),
      cancelDeficitPolicyExemption({
        institutionId: institution.id,
        exemptionId: exemption.id,
        actorUserId: admin.id,
        requestId: unique("cancel-b"),
        reason: "Second concurrent decision",
        now: cancelAt,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await db.policyExemption.findUniqueOrThrow({ where: { id: exemption.id } });
    expect(stored.expiresAt?.toISOString()).toBe(cancelAt.toISOString());
    expect(
      await db.auditEvent.count({
        where: { institutionId: institution.id, entityId: exemption.id, action: "POLICY_EXEMPTION_CANCELLED" },
      })
    ).toBe(1);
  });

  test("an already expired exemption cannot manufacture a cancellation audit", async () => {
    const { institution, admin, resident } = await fixture();
    const exemption = await db.policyExemption.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        policyType: "DEFICIT_RESTRICTION",
        reason: "Historical exemption",
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        expiresAt: new Date("2026-09-02T00:00:00.000Z"),
        approvedByUserId: admin.id,
      },
    });

    const error = await cancelDeficitPolicyExemption({
      institutionId: institution.id,
      exemptionId: exemption.id,
      actorUserId: admin.id,
      requestId: unique("cancel"),
      reason: "Late cancellation",
      now: new Date("2026-09-06T06:00:00.000Z"),
    }).then(() => null).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
    expect(
      await db.auditEvent.count({
        where: { institutionId: institution.id, entityId: exemption.id, action: "POLICY_EXEMPTION_CANCELLED" },
      })
    ).toBe(0);
  });
});
