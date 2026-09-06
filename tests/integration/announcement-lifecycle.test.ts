import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import {
  announcementAuditSnapshot,
  announcementLifecycleState,
  decorateAnnouncementLifecycle,
  lockAnnouncementMutation,
} from "@/lib/domain/announcement-lifecycle";

const prefix = "phase60-announcement-";
const institutionIds: string[] = [];

async function fixture() {
  const institution = await db.institution.create({
    data: { name: `${prefix}${crypto.randomUUID()}`, timezone: "UTC" },
  });
  institutionIds.push(institution.id);
  const announcement = await db.announcement.create({
    data: {
      institutionId: institution.id,
      title: "Kitchen timing update",
      message: "Dinner service starts thirty minutes later tonight.",
      type: "INFO",
      priority: "NORMAL",
      target: "RESIDENTS",
      publishAt: new Date("2026-09-06T10:00:00.000Z"),
      expiresAt: new Date("2026-09-07T10:00:00.000Z"),
      pinned: true,
      createdByUserId: "admin-test",
    },
  });
  return { institution, announcement };
}

afterAll(async () => {
  if (institutionIds.length > 0) {
    await db.auditEvent.deleteMany({ where: { institutionId: { in: institutionIds } } });
    await db.announcement.deleteMany({ where: { institutionId: { in: institutionIds } } });
    await db.institution.deleteMany({ where: { id: { in: institutionIds } } });
  }
  await db.$disconnect();
});

describe("announcement lifecycle integrity", () => {
  test("archive state is append-only and preserves publication data", async () => {
    const { institution, announcement } = await fixture();
    const archivedAt = new Date("2026-09-06T12:00:00.000Z");
    const before = announcementAuditSnapshot(announcement);

    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_ARCHIVED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt: archivedAt,
      reason: "Superseded by a corrected notice",
      beforeSummary: JSON.stringify(before),
      afterSummary: JSON.stringify({ ...before, lifecycle: { archived: true } }),
    });

    const state = await announcementLifecycleState(db, institution.id, announcement.id);
    expect(state.archived).toBe(true);
    expect(state.archivedAt?.toISOString()).toBe(archivedAt.toISOString());
    expect(state.archiveReason).toBe("Superseded by a corrected notice");

    const stored = await db.announcement.findUniqueOrThrow({ where: { id: announcement.id } });
    expect(stored.message).toBe(announcement.message);
    expect(stored.expiresAt?.toISOString()).toBe(announcement.expiresAt?.toISOString());
    expect(stored.pinned).toBe(true);
  });

  test("unarchive and republish lifecycle events reactivate the record", async () => {
    const { institution, announcement } = await fixture();
    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_ARCHIVED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt: new Date("2026-09-06T12:00:00.000Z"),
      reason: "Temporary withdrawal",
    });
    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_UNARCHIVED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt: new Date("2026-09-06T12:00:00.001Z"),
      reason: "Issue resolved",
    });

    let state = await announcementLifecycleState(db, institution.id, announcement.id);
    expect(state.archived).toBe(false);
    expect(state.lastTransitionAt?.toISOString()).toBe("2026-09-06T12:00:00.001Z");

    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_ARCHIVED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt: new Date("2026-09-06T12:00:00.002Z"),
      reason: "Archive again",
    });
    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_REPUBLISHED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt: new Date("2026-09-06T12:00:00.003Z"),
      reason: "Republished with corrected wording",
    });

    state = await announcementLifecycleState(db, institution.id, announcement.id);
    expect(state.archived).toBe(false);
    expect(state.lastTransitionAt?.toISOString()).toBe("2026-09-06T12:00:00.003Z");
  });

  test("decorated feed metadata separates archived and active records", async () => {
    const { institution, announcement } = await fixture();
    const active = await db.announcement.create({
      data: {
        institutionId: institution.id,
        title: "Active notice",
        message: "This one remains visible.",
        publishAt: new Date("2026-09-06T10:00:00.000Z"),
      },
    });
    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_ARCHIVED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt: new Date("2026-09-06T12:00:00.000Z"),
      reason: "History only",
    });

    const decorated = await decorateAnnouncementLifecycle(db, institution.id, [announcement, active]);
    const archived = decorated.find((row) => row.id === announcement.id);
    const visible = decorated.find((row) => row.id === active.id);
    expect(archived?.archived).toBe(true);
    expect(visible?.archived).toBe(false);
  });

  test("competing announcement mutations serialize on the physical row", async () => {
    const { institution, announcement } = await fixture();
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstLocked!: () => void;
    const locked = new Promise<void>((resolve) => { firstLocked = resolve; });

    const first = db.$transaction(async (tx) => {
      await lockAnnouncementMutation(tx, institution.id, announcement.id);
      firstLocked();
      await release;
    });

    await locked;
    let secondAcquired = false;
    const second = db.$transaction(async (tx) => {
      await lockAnnouncementMutation(tx, institution.id, announcement.id);
      secondAcquired = true;
    });

    await Bun.sleep(75);
    expect(secondAcquired).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  test("explicit audit occurrence time is persisted exactly", async () => {
    const { institution, announcement } = await fixture();
    const occurredAt = new Date("2026-09-06T12:34:56.789Z");
    await appendAudit({
      institutionId: institution.id,
      actorUserId: "admin-test",
      actorRole: "ADMIN",
      action: "ANNOUNCEMENT_ARCHIVED",
      entityType: "ANNOUNCEMENT",
      entityId: announcement.id,
      occurredAt,
      reason: "Ordering proof",
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { institutionId: institution.id, entityId: announcement.id, action: "ANNOUNCEMENT_ARCHIVED" },
    });
    expect(event.occurredAt.toISOString()).toBe(occurredAt.toISOString());
  });
});
