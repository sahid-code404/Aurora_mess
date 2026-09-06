import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createFixture(status = "PENDING_APPROVAL") {
  const institution = await db.institution.create({
    data: { name: unique("Phase50 Institution"), settings: { create: {} } },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status,
      email: `${crypto.randomUUID()}@phase50.test`,
      passwordHash: "phase50-test-only",
    },
  });
  return { institution, resident };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("resident lifecycle serialization", () => {
  test("a second lifecycle decision waits on the same resident User row", async () => {
    const { institution, resident } = await createFixture("ACTIVE");
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondAcquired = false;

    const first = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    await firstLocked.promise;

    const second = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      secondAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  test("a competing rejection re-reads ACTIVE after approval commits and cannot create false lifecycle history", async () => {
    const { institution, resident } = await createFixture("PENDING_APPROVAL");
    const approvalWritten = deferred();
    const releaseApproval = deferred();
    let rejectionLockAcquired = false;

    const approve = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      const current = await tx.user.findUniqueOrThrow({ where: { id: resident.id } });
      expect(current.status).toBe("PENDING_APPROVAL");
      await tx.user.update({ where: { id: resident.id }, data: { status: "ACTIVE" } });
      await tx.userStatusHistory.create({
        data: {
          userId: resident.id,
          fromStatus: current.status,
          toStatus: "ACTIVE",
          reason: "Phase50 approval winner",
        },
      });
      approvalWritten.resolve();
      await releaseApproval.promise;
    });

    await approvalWritten.promise;

    const reject = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      rejectionLockAcquired = true;
      const current = await tx.user.findUniqueOrThrow({ where: { id: resident.id } });
      if (current.status !== "PENDING_APPROVAL" && current.status !== "CHANGES_REQUESTED") {
        return "CONFLICT" as const;
      }
      await tx.user.update({ where: { id: resident.id }, data: { status: "REJECTED" } });
      await tx.userStatusHistory.create({
        data: {
          userId: resident.id,
          fromStatus: current.status,
          toStatus: "REJECTED",
          reason: "Phase50 stale rejection must never happen",
        },
      });
      return "REJECTED" as const;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejectionLockAcquired).toBe(false);

    releaseApproval.resolve();
    await approve;
    expect(await reject).toBe("CONFLICT");

    const finalResident = await db.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(finalResident.status).toBe("ACTIVE");
    expect(
      await db.userStatusHistory.count({ where: { userId: resident.id, toStatus: "REJECTED" } })
    ).toBe(0);
    expect(
      await db.userStatusHistory.count({ where: { userId: resident.id, toStatus: "ACTIVE" } })
    ).toBe(1);
  });

  test("lifecycle and financial mutations share the same stable User-row mutex", async () => {
    const { institution, resident } = await createFixture("ACTIVE");
    const lifecycleLocked = deferred();
    const releaseLifecycle = deferred();
    let financialAcquired = false;

    const lifecycle = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      lifecycleLocked.resolve();
      await releaseLifecycle.promise;
    });

    await lifecycleLocked.promise;

    const financial = db.$transaction(async (tx) => {
      await lockResidentFinancialMutation(tx, institution.id, resident.id);
      financialAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(financialAcquired).toBe(false);

    releaseLifecycle.resolve();
    await Promise.all([lifecycle, financial]);
    expect(financialAcquired).toBe(true);
  });

  test("unknown and cross-institution resident ids fail closed", async () => {
    const { institution, resident } = await createFixture("ACTIVE");
    const other = await db.institution.create({
      data: { name: unique("Phase50 Other Institution"), settings: { create: {} } },
    });

    for (const [institutionId, residentId] of [
      [institution.id, unique("missing-resident")],
      [other.id, resident.id],
    ]) {
      const error = await db
        .$transaction(async (tx) => lockResidentLifecycleMutation(tx, institutionId, residentId))
        .then(() => null)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: CODES.NOT_FOUND, status: 404 });
    }
  });
});
