import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(path).text();
}

const schema = await source("prisma/schema.prisma");
const migration = await source("prisma/migrations/20260906_100000_calendar_event_temporal_lifecycle/migration.sql");
const engine = await source("src/lib/domain/meal-engine.ts");
const cancelRoute = await source("src/app/api/v1/admin/calendar/[id]/route.ts");
const calendarRoute = await source("src/app/api/v1/calendar/route.ts");
const calendarView = await source("src/components/app/admin/calendar.tsx");
const approveLeave = await source("src/app/api/v1/admin/leave-requests/[id]/approve/route.ts");
const residentLeaves = await source("src/app/api/v1/leave-requests/route.ts");
const adminLeaves = await source("src/app/api/v1/admin/leave-requests/route.ts");

describe("calendar temporal lifecycle source contracts", () => {
  test("calendar cancellation provenance is persisted and migrated", () => {
    const model = schema.slice(schema.indexOf("model CalendarEvent {"), schema.indexOf("model CalendarEventMeal"));
    expect(model).toContain("cancelledAt");
    expect(model).toContain("cancelledByUserId");
    expect(model).toContain("cancelReason");
    expect(migration).toContain('ADD COLUMN "cancelledAt"');
    expect(migration).toContain('ADD COLUMN "cancelledByUserId"');
    expect(migration).toContain('ADD COLUMN "cancelReason"');
  });

  test("Admin cancellation is reasoned soft-cancel, never hard delete", () => {
    expect(cancelRoute).toContain("reasonSchema");
    expect(cancelRoute).toContain("cancelledAt: now");
    expect(cancelRoute).toContain("cancelledByUserId: ctx.user.id");
    expect(cancelRoute).toContain("cancelReason: body.reason");
    expect(cancelRoute).toContain('action: "CALENDAR_EVENT_CANCELLED"');
    expect(cancelRoute).not.toContain("calendarEvent.delete(");
  });

  test("live calendar and meal evaluation ignore cancelled events", () => {
    expect(calendarRoute).toContain("cancelledAt: null");
    const liveFilters = engine.match(/cancelledAt: null/g) ?? [];
    expect(liveFilters.length).toBeGreaterThanOrEqual(3);
  });

  test("historical freeze reconstructs calendar and leave facts at lockAt", () => {
    expect(engine).toContain("calendarEventActiveAtBoundary");
    expect(engine).toContain("const lockBoundary = new Date(instRow.lockAt)");
    expect(engine).toContain("calendarEventActiveAtBoundary(e, lockBoundary)");
    expect(engine).toContain("l.reviewedAt.getTime() <= lockBoundary.getTime()");
    expect(engine).not.toContain("e.createdAt.getTime() <= new Date(instRow.cutoffAt).getTime()");
    expect(engine).not.toContain("l.reviewedAt.getTime() <= new Date(instRow.cutoffAt).getTime()");
  });

  test("leave approval and both leave previews use the actual lock boundary", () => {
    expect(approveLeave).toContain("lockAt: { gt: now }");
    expect(approveLeave).not.toContain("cutoffAt: { gt: now }");
    expect(residentLeaves).toContain("lockAt: { gt: now }");
    expect(residentLeaves).toContain("lockAt: { lte: now }");
    expect(adminLeaves).toContain("lockAt: { gt: now }");
    expect(adminLeaves).toContain("lockAt: { lte: now }");
  });

  test("Admin Calendar UI requires a reason and explains locked history", () => {
    expect(calendarView).toContain('label: "Cancel event"');
    expect(calendarView).toContain('confirmLabel="Cancel event"');
    expect(calendarView).toContain("requireReason");
    expect(calendarView).toContain("{ reason: reason.trim() }");
    expect(calendarView).toContain("Meals already past their lock boundary keep their historical state.");
    expect(calendarView).not.toContain('label: "Delete event"');
    expect(calendarView).not.toContain('toast.success("Event deleted"');
  });
});
