import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { CODES } from "@/lib/errors";
import {
  cancelResidentDeletion,
  refreshDueResidentRetirements,
  RESIDENT_DELETION_GRACE_DAYS,
  scheduleResidentDeletion,
} from "@/lib/domain/resident-retirement";

const prefix = "phase52-resident-delete-";

function unique(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
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
      email: `${crypto.randomUUID()}@phase52-admin.test`,
      passwordHash: "phase52-test-only",
    },
  });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${crypto.randomUUID()}@phase52-resident.test`,
      passwordHash: "phase52-test-only",
      membershipEffectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
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
    const users = await db.user.findMany({ where: { institutionId: { in: ids } }, select: { id: true } });
    const userIds = users.map((row) => row.id);
    await db.task.deleteMany({ where: { institutionId: { in: ids } } });
    await db.deletionRequest.deleteMany({ where: { institutionId: { in: ids } } });
    await db.outboxEvent.deleteMany({ where: { institutionId: { in: ids } } });
    await db.auditEvent.deleteMany({ where: { institutionId: { in: ids } } });
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

describe("resident deletion queue lifecycle", () => {
  test("schedules ACTIVE -> PENDING_DELETION for exactly seven days and records lifecycle evidence", async () => {
    const { institution, admin, resident } = await fixture();
    const now = new Date("2026-09-06T06:00:00.000Z");

    const result = await scheduleResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("request"),
      reason: "Resident moved out",
      now,
    });

    expect(RESIDENT_DELETION_GRACE_DAYS).toBe(7);
    expect(result.resident.status).toBe("PENDING_DELETION");
    expect(result.request.status).toBe("SCHEDULED");
    expect(result.request.scheduledFor?.toISOString()).toBe("2026-09-13T06:00:00.000Z");

    const stored = await db.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(stored.status).toBe("PENDING_DELETION");
    const history = await db.userStatusHistory.findFirst({
      where: { userId: resident.id },
      orderBy: { createdAt: "desc" },
    });
    expect(history).toMatchObject({
      fromStatus: "ACTIVE",
      toStatus: "PENDING_DELETION",
      changedByUserId: admin.id,
      reason: "Resident moved out",
    });
    const audit = await db.auditEvent.findFirst({
      where: { institutionId: institution.id, entityType: "USER", entityId: resident.id },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit?.action).toBe("RESIDENT_DELETION_SCHEDULED");
  });

  test("blocks deletion while the resident owns unfinished work", async () => {
    const { institution, admin, resident } = await fixture();
    await db.task.create({
      data: {
        institutionId: institution.id,
        taskType: "GENERAL",
        description: "Return kitchen inventory",
        assignedResidentId: resident.id,
        assignedByUserId: admin.id,
        status: "IN_PROGRESS",
      },
    });

    const error = await scheduleResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("request"),
      reason: "Leaving",
      now: new Date("2026-09-06T06:00:00.000Z"),
    }).then(() => null).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
    expect(String((error as Error)?.message ?? error)).toContain("unfinished task");
    const stored = await db.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(stored.status).toBe("ACTIVE");
    expect(
      await db.deletionRequest.count({
        where: { institutionId: institution.id, entityType: "USER", entityId: resident.id },
      })
    ).toBe(0);
  });

  test("restores PENDING_DELETION -> ACTIVE while the grace window is still open", async () => {
    const { institution, admin, resident } = await fixture();
    const now = new Date("2026-09-06T06:00:00.000Z");
    await scheduleResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("schedule"),
      reason: "Leaving",
      now,
    });

    const result = await cancelResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("cancel"),
      reason: "Resident is staying",
      now: new Date("2026-09-10T06:00:00.000Z"),
    });

    expect(result.resident.status).toBe("ACTIVE");
    expect(result.request.status).toBe("CANCELLED");
    expect(result.request.cancelReason).toBe("Resident is staying");
    const latestHistory = await db.userStatusHistory.findFirst({
      where: { userId: resident.id },
      orderBy: { createdAt: "desc" },
    });
    expect(latestHistory).toMatchObject({
      fromStatus: "PENDING_DELETION",
      toStatus: "ACTIVE",
      changedByUserId: admin.id,
    });
  });

  test("due sweep completes the request but retains the resident as historical identity", async () => {
    const { institution, admin, resident } = await fixture();
    const now = new Date("2026-09-01T00:00:00.000Z");
    const scheduled = await scheduleResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("schedule"),
      reason: "Moved away",
      now,
    });

    const sweep = await refreshDueResidentRetirements(
      institution.id,
      db,
      new Date("2026-09-08T00:00:00.001Z")
    );
    expect(sweep.completed).toBe(1);
    expect(sweep.blocked).toBe(0);

    const request = await db.deletionRequest.findUniqueOrThrow({ where: { id: scheduled.request.id } });
    expect(request.status).toBe("COMPLETED");
    expect(request.completedAt).not.toBeNull();

    const retained = await db.user.findUnique({ where: { id: resident.id } });
    expect(retained).not.toBeNull();
    expect(retained?.status).toBe("PENDING_DELETION");
    const audit = await db.auditEvent.findFirst({
      where: {
        institutionId: institution.id,
        entityType: "USER",
        entityId: resident.id,
        action: "RESIDENT_DELETION_COMPLETED",
      },
    });
    expect(audit).not.toBeNull();
  });

  test("a restore attempted after the deadline commits completion and then fails closed", async () => {
    const { institution, admin, resident } = await fixture();
    const scheduled = await scheduleResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("schedule"),
      reason: "Moved away",
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    const error = await cancelResidentDeletion({
      institutionId: institution.id,
      residentId: resident.id,
      actorUserId: admin.id,
      requestId: unique("late-cancel"),
      reason: "Too late",
      now: new Date("2026-09-08T00:00:00.001Z"),
    }).then(() => null).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: CODES.VALIDATION_FAILED, status: 409 });
    const request = await db.deletionRequest.findUniqueOrThrow({ where: { id: scheduled.request.id } });
    expect(request.status).toBe("COMPLETED");
    const retained = await db.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(retained.status).toBe("PENDING_DELETION");
  });
});
