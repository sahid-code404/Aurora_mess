import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import { lockTaskLifecycleMutation } from "@/lib/domain/task-lifecycle";

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

async function createFixture(status = "ACCEPTED") {
  const institution = await db.institution.create({
    data: { name: unique("Phase43 Institution"), settings: { create: {} } },
  });
  const task = await db.task.create({
    data: {
      institutionId: institution.id,
      taskType: "GENERAL",
      description: unique("Task"),
      assignedResidentId: unique("resident"),
      assignedByUserId: unique("admin"),
      status,
    },
  });
  return { institution, task };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("task lifecycle serialization", () => {
  test("a second mutation waits on the same Task row", async () => {
    const { institution, task } = await createFixture();
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondAcquired = false;

    const first = db.$transaction(async (tx) => {
      await lockTaskLifecycleMutation(tx, institution.id, task.id);
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    await firstLocked.promise;

    const second = db.$transaction(async (tx) => {
      await lockTaskLifecycleMutation(tx, institution.id, task.id);
      secondAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  test("a competing reject re-reads IN_PROGRESS after start commits and cannot overwrite it", async () => {
    const { institution, task } = await createFixture("ACCEPTED");
    const started = deferred();
    const releaseStart = deferred();
    let rejectLockAcquired = false;

    const start = db.$transaction(async (tx) => {
      await lockTaskLifecycleMutation(tx, institution.id, task.id);
      const current = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(current.status).toBe("ACCEPTED");
      await tx.task.update({ where: { id: task.id }, data: { status: "IN_PROGRESS" } });
      started.resolve();
      await releaseStart.promise;
    });

    await started.promise;

    const reject = db.$transaction(async (tx) => {
      await lockTaskLifecycleMutation(tx, institution.id, task.id);
      rejectLockAcquired = true;
      const current = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
      if (current.status !== "ASSIGNED" && current.status !== "ACCEPTED") return "CONFLICT" as const;
      await tx.task.update({ where: { id: task.id }, data: { status: "REJECTED" } });
      return "REJECTED" as const;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejectLockAcquired).toBe(false);

    releaseStart.resolve();
    await start;
    expect(await reject).toBe("CONFLICT");

    const finalTask = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finalTask.status).toBe("IN_PROGRESS");
  });

  test("unknown or cross-institution task ids fail closed", async () => {
    const { institution, task } = await createFixture();
    const other = await db.institution.create({ data: { name: unique("Other Institution"), settings: { create: {} } } });

    for (const [institutionId, taskId] of [
      [institution.id, unique("missing-task")],
      [other.id, task.id],
    ]) {
      const error = await db
        .$transaction(async (tx) => lockTaskLifecycleMutation(tx, institutionId, taskId))
        .then(() => null)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: CODES.NOT_FOUND, status: 404 });
    }
  });
});
