import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { lockPolicyMutation } from "@/lib/domain/policy-lifecycle";

const prefix = "phase66-policy-archive-";

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
  const admin = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "ADMIN",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase66-admin.test`,
      passwordHash: "phase66-test-only",
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase66-resident.test`,
      passwordHash: "phase66-test-only",
    },
  });
  const policy = await db.policy.create({
    data: {
      institutionId: institution.id,
      type: "HOUSE_RULES",
      title: unique("policy"),
      content: "Initial immutable policy content.",
      status: "ACTIVE",
    },
  });
  const version = await db.policyVersion.create({
    data: { policyId: policy.id, version: 1, content: policy.content },
  });
  const acceptance = await db.userPolicyAcceptance.create({
    data: {
      userId: resident.id,
      policyId: policy.id,
      policyVersionId: version.id,
      ip: "127.0.0.1",
      userAgent: "phase66-test",
    },
  });
  return { institution, admin, resident, policy, version, acceptance };
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    const policies = await db.policy.findMany({ where: { institutionId: { in: ids } }, select: { id: true } });
    const policyIds = policies.map((row) => row.id);
    if (policyIds.length > 0) {
      await db.userPolicyAcceptance.deleteMany({ where: { policyId: { in: policyIds } } });
      await db.policyVersion.deleteMany({ where: { policyId: { in: policyIds } } });
      await db.policy.deleteMany({ where: { id: { in: policyIds } } });
    }
    await db.auditEvent.deleteMany({ where: { institutionId: { in: ids } } });
    await db.session.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.userStatusHistory.deleteMany({ where: { user: { institutionId: { in: ids } } } });
    await db.userProfile.deleteMany({ where: { users: { some: { institutionId: { in: ids } } } } });
    await db.user.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institutionSecuritySettings.deleteMany({ where: { institutionId: { in: ids } } });
    await db.institution.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
});

describe("policy archive lifecycle", () => {
  test("archive/reactivate preserves immutable versions and resident acceptance history", async () => {
    const { institution, policy, version, acceptance } = await fixture();

    await db.$transaction(async (tx) => {
      const locked = await lockPolicyMutation(tx, institution.id, policy.id);
      expect(locked.status).toBe("ACTIVE");
      await tx.policy.update({ where: { id: policy.id }, data: { status: "ARCHIVED" } });
    });

    expect((await db.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe("ARCHIVED");
    expect(await db.policyVersion.count({ where: { policyId: policy.id } })).toBe(1);
    expect(await db.userPolicyAcceptance.count({ where: { id: acceptance.id, policyVersionId: version.id } })).toBe(1);

    await db.$transaction(async (tx) => {
      const locked = await lockPolicyMutation(tx, institution.id, policy.id);
      expect(locked.status).toBe("ARCHIVED");
      await tx.policy.update({ where: { id: policy.id }, data: { status: "ACTIVE" } });
    });

    expect((await db.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe("ACTIVE");
    expect(await db.policyVersion.count({ where: { policyId: policy.id } })).toBe(1);
    expect(await db.userPolicyAcceptance.count({ where: { id: acceptance.id } })).toBe(1);
  });

  test("competing lifecycle mutations serialize on the Policy row", async () => {
    const { institution, policy } = await fixture();
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondLocked = false;

    const first = db.$transaction(async (tx) => {
      const locked = await lockPolicyMutation(tx, institution.id, policy.id);
      expect(locked.status).toBe("ACTIVE");
      await tx.policy.update({ where: { id: policy.id }, data: { status: "ARCHIVED" } });
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    await firstLocked.promise;

    const second = db.$transaction(async (tx) => {
      const locked = await lockPolicyMutation(tx, institution.id, policy.id);
      secondLocked = true;
      return locked.status;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondLocked).toBe(false);

    releaseFirst.resolve();
    await first;
    expect(await second).toBe("ARCHIVED");
  });
});
