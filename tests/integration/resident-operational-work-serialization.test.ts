import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";
import {
  assertNoUnfinishedResidentTasks,
  lockActiveResidentForTaskAssignment,
} from "@/lib/domain/resident-operational-work";

const prefix = "phase54-resident-work-";

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
    data: { name: unique("institution"), timezone: "Asia/Kolkata", settings: { create: {} } },
  });
  const admin = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "ADMIN",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase54-admin.test`,
      passwordHash: "phase54-test-only",
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase54-resident.test`,
      passwordHash: "phase54-test-only",
    },
  });
  return { institution, admin, resident };
}

async function createTask(institutionId: string, adminId: string, residentId: string) {
  return db.task.create({
    data: {
      institutionId,
      taskType: "GENERAL",
      description: unique("task"),
      assignedResidentId: residentId,
      assignedByUserId: adminId,
      status: "ASSIGNED",
    },
  });
}

afterAll(async () => {
  const institutions = await db.institution.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = institutions.map((row) => row.id);
  if (ids.length > 0) {
    await db.task.deleteMany({ where: { institutionId: { in: ids } } });
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

describe("resident operational work serialization", () => {
  test("unfinished work blocks access removal while the Resident mutex is held", async () => {
    const { institution, admin, resident } = await fixture();
    await createTask(institution.id, admin.id, resident.id);

    const error = await db
      .$transaction(async (tx) => {
        await lockResidentLifecycleMutation(tx, institution.id, resident.id);
        await assertNoUnfinishedResidentTasks(tx, institution.id, resident.id);
      })
      .then(() => null)
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
    expect(String((error as Error)?.message ?? error)).toContain("unfinished task");
  });

  test("assignment winning the Resident mutex makes concurrent deactivation observe unfinished work", async () => {
    const { institution, admin, resident } = await fixture();
    const assignmentLocked = deferred();
    const releaseAssignment = deferred();
    let deactivationLocked = false;

    const assignment = db.$transaction(async (tx) => {
      const authoritative = await lockActiveResidentForTaskAssignment(tx, institution.id, resident.id);
      await tx.task.create({
        data: {
          institutionId: institution.id,
          taskType: "GENERAL",
          description: unique("concurrent-assignment"),
          assignedResidentId: authoritative.id,
          assignedByUserId: admin.id,
          status: "ASSIGNED",
        },
      });
      assignmentLocked.resolve();
      await releaseAssignment.promise;
    });

    await assignmentLocked.promise;

    const deactivation = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      deactivationLocked = true;
      await assertNoUnfinishedResidentTasks(tx, institution.id, resident.id);
      await tx.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });
    });
    const deactivationResult = deactivation.then(() => null).catch((value: unknown) => value);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deactivationLocked).toBe(false);

    releaseAssignment.resolve();
    await assignment;
    const error = await deactivationResult;
    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
    expect((await db.user.findUniqueOrThrow({ where: { id: resident.id } })).status).toBe("ACTIVE");
  });

  test("access removal winning the Resident mutex makes concurrent assignment re-read non-ACTIVE state", async () => {
    const { institution, resident } = await fixture();
    const lifecycleLocked = deferred();
    const releaseLifecycle = deferred();
    let assignmentLocked = false;

    const lifecycle = db.$transaction(async (tx) => {
      await lockResidentLifecycleMutation(tx, institution.id, resident.id);
      await tx.user.update({ where: { id: resident.id }, data: { status: "INACTIVE" } });
      lifecycleLocked.resolve();
      await releaseLifecycle.promise;
    });

    await lifecycleLocked.promise;

    const assignment = db.$transaction(async (tx) => {
      const authoritative = await lockActiveResidentForTaskAssignment(tx, institution.id, resident.id);
      assignmentLocked = true;
      return authoritative;
    });
    const assignmentResult = assignment.then(() => null).catch((value: unknown) => value);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(assignmentLocked).toBe(false);

    releaseLifecycle.resolve();
    await lifecycle;
    const error = await assignmentResult;
    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 400 });
  });
});
