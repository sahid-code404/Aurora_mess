import { describe, expect, test } from "bun:test";

const adminCollection = await Bun.file("src/app/api/v1/admin/announcements/route.ts").text();
const adminItem = await Bun.file("src/app/api/v1/admin/announcements/[id]/route.ts").text();
const activeFeed = await Bun.file("src/app/api/v1/announcements/route.ts").text();
const dashboard = await Bun.file("src/app/api/v1/me/dashboard/route.ts").text();
const lifecycle = await Bun.file("src/lib/domain/announcement-lifecycle.ts").text();
const audit = await Bun.file("src/lib/audit.ts").text();
const ui = await Bun.file("src/components/app/admin/announcements.tsx").text();

describe("announcement lifecycle source contracts", () => {
  test("published announcement rows are never hard-deleted", () => {
    expect(adminItem).not.toContain("announcement.delete({");
    expect(adminItem).toContain("compatibility alias");
    expect(adminItem).toContain('action: "ANNOUNCEMENT_ARCHIVED"');
    expect(adminItem).toContain("hardDeleted: false");
  });

  test("publish and mutation audit records share their database transactions", () => {
    expect(adminCollection).toContain("db.$transaction(async (tx)");
    expect(adminCollection).toContain("announcementAuditSnapshot(row)");
    expect(adminCollection).toContain("tx\n    );");
    expect(adminItem).toContain("await lockAnnouncementMutation(tx");
    expect(adminItem).toContain("requireAnnouncementAfterLock(tx");
    expect(adminItem).toContain("announcementAuditSnapshot(announcement)");
    expect(adminItem).toContain("announcementAuditSnapshot(updated)");
  });

  test("archive state does not overwrite the publication expiry", () => {
    const archiveBlock = adminItem.slice(
      adminItem.indexOf('if (body.action === "ARCHIVE")'),
      adminItem.indexOf('if (body.action === "UNARCHIVE")')
    );
    expect(archiveBlock).not.toContain("expiresAt:");
    expect(archiveBlock).toContain('action: "ANNOUNCEMENT_ARCHIVED"');
  });

  test("active resident surfaces filter the append-only lifecycle", () => {
    expect(activeFeed).toContain("decorateAnnouncementLifecycle");
    expect(activeFeed).toContain(".filter((row) => !row.archived)");
    expect(dashboard).toContain("decorateAnnouncementLifecycle");
    expect(dashboard).toContain(".filter((announcement) => !announcement.archived)");
  });

  test("lifecycle transitions are serialized and monotonically timestamped", () => {
    expect(lifecycle).toContain('FROM "Announcement"');
    expect(lifecycle).toContain("FOR UPDATE");
    expect(lifecycle).toContain("lastTransitionAt");
    expect(lifecycle).toContain("prior + 1");
    expect(audit).toContain("occurredAt?: Date | null");
    expect(audit).toContain("input.occurredAt ? { occurredAt: input.occurredAt } : {}");
  });

  test("admin UI exposes archive history instead of destructive deletion", () => {
    expect(ui).not.toContain("deleteJson");
    expect(ui).not.toContain("Delete announcement");
    expect(ui).toContain("Archive announcement");
    expect(ui).toContain("requireReason");
    expect(ui).toContain("History kept");
    expect(ui).toContain("Republish");
  });
});
