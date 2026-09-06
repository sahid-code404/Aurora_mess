import { describe, expect, test } from "bun:test";
import { nextAnnouncementTransitionAt } from "@/lib/domain/announcement-lifecycle";

describe("announcement lifecycle ordering", () => {
  test("first transition uses authoritative wall clock", () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    const next = nextAnnouncementTransitionAt(
      {
        archived: false,
        archivedAt: null,
        archiveReason: null,
        archivedByUserId: null,
        lastTransitionAt: null,
      },
      now
    );
    expect(next.toISOString()).toBe(now.toISOString());
  });

  test("a lock waiter advances beyond the previous lifecycle timestamp", () => {
    const previous = new Date("2026-09-06T12:00:00.500Z");
    const staleWallClock = new Date("2026-09-06T12:00:00.100Z");
    const next = nextAnnouncementTransitionAt(
      {
        archived: true,
        archivedAt: previous,
        archiveReason: "Old publication",
        archivedByUserId: "admin-1",
        lastTransitionAt: previous,
      },
      staleWallClock
    );
    expect(next.getTime()).toBe(previous.getTime() + 1);
  });
});
