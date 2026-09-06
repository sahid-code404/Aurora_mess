import { describe, expect, test } from "bun:test";

const schema = await Bun.file("prisma/schema.prisma").text();
const migration = await Bun.file(
  "prisma/migrations/20260906_080000_meal_definition_retirement_lifecycle/migration.sql"
).text();
const domain = await Bun.file("src/lib/domain/meal-retirement.ts").text();
const engine = await Bun.file("src/lib/domain/meal-engine.ts").text();
const listRoute = await Bun.file("src/app/api/v1/admin/meal-definitions/route.ts").text();
const detailRoute = await Bun.file("src/app/api/v1/admin/meal-definitions/[id]/route.ts").text();
const scheduleRoute = await Bun.file(
  "src/app/api/v1/admin/meal-definitions/[id]/request-deletion/route.ts"
).text();
const cancelRoute = await Bun.file(
  "src/app/api/v1/admin/meal-definitions/[id]/cancel-deletion/route.ts"
).text();
const restoreRoute = await Bun.file("src/app/api/v1/admin/meal-definitions/[id]/restore/route.ts").text();
const ui = await Bun.file("src/components/app/admin/meal-configuration.tsx").text();

describe("meal-definition retirement source contracts", () => {
  test("deletion request persists cancellation provenance and a due-sweep index", () => {
    expect(schema).toContain("cancelReason      String?");
    expect(schema).toContain("cancelledByUserId String?");
    expect(schema).toContain("cancelledAt       DateTime?");
    expect(schema).toContain("@@index([institutionId, entityType, status, scheduledFor])");
    expect(migration).toContain("SET "status" = 'SCHEDULED'");
    expect(migration).toContain(""archivedAt" = COALESCE");
    expect(migration).toContain(""active" = FALSE");
  });

  test("scheduling archives immediately and persists SCHEDULED instead of dead QUEUED copy", () => {
    expect(domain).toContain('status: "SCHEDULED"');
    expect(domain).toContain("archivedAt: definition.archivedAt ?? now");
    expect(domain).toContain("deleteRequestedAt: now");
    expect(scheduleRoute).toContain("scheduleMealDefinitionDeletion");
  });

  test("due requests are guarded to COMPLETED or fail closed as BLOCKED", () => {
    expect(domain).toContain('status: "COMPLETED", completedAt: now');
    expect(domain).toContain('status: "BLOCKED"');
    expect(domain).toContain("manual reconciliation is required");
    expect(engine.indexOf("refreshDueMealDefinitionRetirements")).toBeLessThan(
      engine.indexOf("client.mealDefinition.findMany")
    );
  });

  test("Admin reads advance lifecycle and remove completed tombstones from live configuration", () => {
    expect(listRoute).toContain("await refreshDueMealDefinitionRetirements(ctx.institutionId)");
    expect(listRoute).toContain('status !== "COMPLETED"');
    expect(listRoute).toContain("deletionRequest: serializeDeletionRequest");
    expect(detailRoute).toContain("has completed its deletion lifecycle");
  });

  test("editing cannot mutate a pending or completed retirement and restore is explicit", () => {
    expect(detailRoute).toContain("Cancel the deletion request before editing this meal definition.");
    expect(detailRoute).toContain("A completed deletion tombstone cannot be edited.");
    expect(restoreRoute).toContain("restoreMealDefinition");
    expect(domain).toContain("A completed deletion tombstone cannot be restored.");
  });

  test("cancellation is reasoned, audited and leaves archive state intact", () => {
    expect(cancelRoute).toContain("reasonSchema");
    expect(cancelRoute).toContain("cancelMealDefinitionDeletion");
    expect(domain).toContain('action: "MEAL_DELETION_CANCELLED"');
    expect(domain).toContain("data: { deleteRequestedAt: null }");
    expect(domain).not.toContain("data: { deleteRequestedAt: null, archivedAt: null }");
  });

  test("Admin UI exposes Restore/Cancel deletion and no longer claims editing restores archives", () => {
    expect(ui).toContain('label: "Restore"');
    expect(ui).toContain('label: "Cancel deletion…"');
    expect(ui).toContain("The deletion request stays in history as CANCELLED");
    expect(ui).toContain("Restore the meal explicitly");
    expect(ui).not.toContain("This can be reversed by editing the meal.");
  });
});
