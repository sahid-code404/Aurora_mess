from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}\n{old[:600]}")
    p.write_text(text.replace(old, new, 1))


# Shared PostgreSQL mutex on MealDefinition.
replace_once(
    "src/lib/domain/meal-retirement.ts",
    '''import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";''',
    '''import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";'''
)
replace_once(
    "src/lib/domain/meal-retirement.ts",
    '''async function inTransaction<T>(client: Client, fn: (tx: Client) => Promise<T>): Promise<T> {
  if (typeof client?.$transaction === "function") return client.$transaction(fn);
  return fn(client);
}
''',
    '''async function inTransaction<T>(client: Client, fn: (tx: Client) => Promise<T>): Promise<T> {
  if (typeof client?.$transaction === "function") return client.$transaction(fn);
  return fn(client);
}

/**
 * Serialize every lifecycle mutation for one meal definition. The definition
 * row is the stable mutex shared by archive, edit, deletion scheduling,
 * cancellation, restoration and due-retirement completion.
 */
export async function lockMealDefinitionMutation(
  client: Client,
  institutionId: string,
  mealDefinitionId: string
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "MealDefinition"
    WHERE "id" = ${mealDefinitionId}
      AND "institutionId" = ${institutionId}
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);
  }
}
'''
)
# schedule/cancel/restore acquire row before authoritative read.
for marker in [
    '''  return inTransaction(client, async (tx) => {
    const definition = await tx.mealDefinition.findFirst({
      where: { id: input.mealDefinitionId, institutionId: input.institutionId },
    });
    if (!definition) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);''',
]:
    pass
text_path = ROOT / "src/lib/domain/meal-retirement.ts"
text = text_path.read_text()
old = '''  return inTransaction(client, async (tx) => {
    const definition = await tx.mealDefinition.findFirst({
      where: { id: input.mealDefinitionId, institutionId: input.institutionId },
    });
    if (!definition) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);'''
new = '''  return inTransaction(client, async (tx) => {
    await lockMealDefinitionMutation(tx, input.institutionId, input.mealDefinitionId);
    const definition = await tx.mealDefinition.findFirst({
      where: { id: input.mealDefinitionId, institutionId: input.institutionId },
    });
    if (!definition) throw new ApiError(CODES.NOT_FOUND, "This meal definition could not be found.", 404);'''
count = text.count(old)
if count != 3:
    raise SystemExit(f"meal-retirement.ts: expected 3 actor mutation reads, found {count}")
text_path.write_text(text.replace(old, new))

# Due sweep: if definition exists in discovery read, lock it before authoritative
# request/definition re-read. Missing definitions still use guarded request update.
replace_once(
    "src/lib/domain/meal-retirement.ts",
    '''  for (const candidate of due) {
    await inTransaction(client, async (tx) => {
      const request = await tx.deletionRequest.findFirst({''',
    '''  for (const candidate of due) {
    await inTransaction(client, async (tx) => {
      const discoveredDefinition = await tx.mealDefinition.findFirst({
        where: { id: candidate.entityId, institutionId },
        select: { id: true },
      });
      if (discoveredDefinition) {
        await lockMealDefinitionMutation(tx, institutionId, candidate.entityId);
      }

      const request = await tx.deletionRequest.findFirst({'''
)

# Archive path joins the shared mutex.
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/archive/route.ts",
    '''import { requireInstitutionContext } from "@/lib/domain/meal-engine";''',
    '''import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { lockMealDefinitionMutation } from "@/lib/domain/meal-retirement";'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/archive/route.ts",
    '''  const result = await db.$transaction(async (tx) => {
    const def = await tx.mealDefinition.findFirst({''',
    '''  const result = await db.$transaction(async (tx) => {
    await lockMealDefinitionMutation(tx, ctx.institutionId, ctx.params.id);
    const def = await tx.mealDefinition.findFirst({'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/archive/route.ts",
    '''    if (def.archivedAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This meal definition is already archived.", 409);
    }
    const now = new Date();''',
    '''    if (def.archivedAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This meal definition is already archived.", 409);
    }
    const activeDeletion = await tx.deletionRequest.findFirst({
      where: {
        institutionId: ctx.institutionId,
        entityType: "MEAL_DEFINITION",
        entityId: def.id,
        status: { in: ["QUEUED", "SCHEDULED", "BLOCKED"] },
      },
    });
    if (activeDeletion || def.deleteRequestedAt) {
      throw new ApiError(CODES.VALIDATION_FAILED, "This meal definition already has an active deletion request.", 409);
    }
    const now = new Date();'''
)

# PUT joins the mutex before state/deletion reads.
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''import { refreshDueMealDefinitionRetirements } from "@/lib/domain/meal-retirement";''',
    '''import {
  lockMealDefinitionMutation,
  refreshDueMealDefinitionRetirements,
} from "@/lib/domain/meal-retirement";'''
)
replace_once(
    "src/app/api/v1/admin/meal-definitions/[id]/route.ts",
    '''  const result = await db.$transaction(async (tx) => {
    const def = await tx.mealDefinition.findFirst({''',
    '''  const result = await db.$transaction(async (tx) => {
    await lockMealDefinitionMutation(tx, ctx.institutionId, ctx.params.id);
    const def = await tx.mealDefinition.findFirst({'''
)

# Add concurrency source and integration assertions.
replace_once(
    "tests/unit/meal-retirement-lifecycle-source.test.ts",
    '''  test("scheduling archives immediately and persists SCHEDULED instead of dead QUEUED copy", () => {
    expect(domain).toContain('status: "SCHEDULED"');''',
    '''  test("all lifecycle mutations share the MealDefinition row mutex", () => {
    expect(domain).toContain('FROM "MealDefinition"');
    expect(domain).toContain("FOR UPDATE");
    expect(domain.match(/lockMealDefinitionMutation\(tx/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(detailRoute).toContain("await lockMealDefinitionMutation(tx, ctx.institutionId, ctx.params.id)");
    const archive = Bun.file("src/app/api/v1/admin/meal-definitions/[id]/archive/route.ts");
    expect(archive.size).toBeGreaterThan(0);
  });

  test("scheduling archives immediately and persists SCHEDULED instead of dead QUEUED copy", () => {
    expect(domain).toContain('status: "SCHEDULED"');'''
)

# Integration: concurrent schedule attempts cannot create two active requests.
replace_once(
    "tests/integration/meal-retirement-lifecycle.test.ts",
    '''  test("due legacy queued deletion completes as a tombstone and cannot be restored", async () => {''',
    '''  test("concurrent deletion schedules serialize and create only one active request", async () => {
    const { institution, admin, definition } = await fixture();
    const attempts = await Promise.allSettled([
      scheduleMealDefinitionDeletion({
        institutionId: institution.id,
        mealDefinitionId: definition.id,
        actorUserId: admin.id,
        requestId: unique("schedule-a"),
        reason: "Concurrent schedule A",
      }),
      scheduleMealDefinitionDeletion({
        institutionId: institution.id,
        mealDefinitionId: definition.id,
        actorUserId: admin.id,
        requestId: unique("schedule-b"),
        reason: "Concurrent schedule B",
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await db.deletionRequest.count({
        where: {
          institutionId: institution.id,
          entityType: "MEAL_DEFINITION",
          entityId: definition.id,
          status: { in: ["QUEUED", "SCHEDULED", "BLOCKED"] },
        },
      })
    ).toBe(1);
  });

  test("due legacy queued deletion completes as a tombstone and cannot be restored", async () => {'''
)

print("Phase 46 lifecycle lock refinement prepared")
