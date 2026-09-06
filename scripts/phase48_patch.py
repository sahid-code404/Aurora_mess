from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def patch(path: str, old: str, new: str, count: int = 1) -> None:
    p = ROOT / path
    text = p.read_text()
    actual = text.count(old)
    assert actual == count, f"{path}: expected {count} occurrences, found {actual}"
    p.write_text(text.replace(old, new, count))

# Prisma contract: SCHEDULED had no definable opening transition; live instances
# are open from materialization until the authoritative lock instant.
patch(
    "prisma/schema.prisma",
    '  status                  String   @default("SCHEDULED") // SCHEDULED | OPEN | LOCKED | SERVICE_ACTIVE | COMPLETED | CANCELLED',
    '  status                  String   @default("OPEN") // OPEN | LOCKED | SERVICE_ACTIVE | COMPLETED | CANCELLED',
)

# Temporal status engine + lock instant.
patch(
    "src/lib/domain/meal-engine.ts",
    '''/** Instance status from server time: OPEN → LOCKED → COMPLETED. */\nexport function computeInstanceStatus(now: Date, cutoffAt: Date, serviceEndAt: Date): string {\n  if (now.getTime() < cutoffAt.getTime()) return "OPEN";\n  if (now.getTime() < serviceEndAt.getTime()) return "LOCKED";\n  return "COMPLETED";\n}''',
    '''/** The selection lock can never be later than service start. */\nexport function computeMealLockAt(cutoffAt: Date, serviceStartAt: Date): Date {\n  return new Date(Math.min(cutoffAt.getTime(), serviceStartAt.getTime()));\n}\n\n/** Instance status from authoritative server time. CANCELLED is handled as terminal by refresh callers. */\nexport function computeInstanceStatus(\n  now: Date,\n  lockAt: Date,\n  serviceStartAt: Date,\n  serviceEndAt: Date\n): "OPEN" | "LOCKED" | "SERVICE_ACTIVE" | "COMPLETED" {\n  if (now.getTime() >= serviceEndAt.getTime()) return "COMPLETED";\n  if (now.getTime() >= serviceStartAt.getTime()) return "SERVICE_ACTIVE";\n  if (now.getTime() >= lockAt.getTime()) return "LOCKED";\n  return "OPEN";\n}''',
)
patch(
    "src/lib/domain/meal-engine.ts",
    '''      const cutoffAt = computeCutoffAt(dateKey, def.cutoffLocalTime, offsetDays, tz);\n      const window = computeServiceWindow(dateKey, def.serviceStartLocal, def.serviceEndLocal, tz);\n      try {''',
    '''      const cutoffAt = computeCutoffAt(dateKey, def.cutoffLocalTime, offsetDays, tz);\n      const window = computeServiceWindow(dateKey, def.serviceStartLocal, def.serviceEndLocal, tz);\n      const lockAt = computeMealLockAt(cutoffAt, window.startAt);\n      try {''',
)
patch(
    "src/lib/domain/meal-engine.ts",
    '''            cutoffAt,\n            lockAt: cutoffAt,\n            status: computeInstanceStatus(now, cutoffAt, window.endAt),''',
    '''            cutoffAt,\n            lockAt,\n            status: computeInstanceStatus(now, lockAt, window.startAt, window.endAt),''',
)
patch(
    "src/lib/domain/meal-engine.ts",
    '''  const instances = (await client.mealInstance.findMany({\n    where: { institutionId, serviceDate: { gte: fromMid, lte: toMid }, cutoffAt: { lte: now } },\n  })) as Record<string, any>[];''',
    '''  const instances = (await client.mealInstance.findMany({\n    where: {\n      institutionId,\n      serviceDate: { gte: fromMid, lte: toMid },\n      status: { not: "CANCELLED" },\n      OR: [{ lockAt: { lte: now } }, { serviceStartAt: { lte: now } }, { serviceEndAt: { lte: now } }],\n    },\n  })) as Record<string, any>[];''',
)
patch(
    "src/lib/domain/meal-engine.ts",
    '''  for (const inst of instances) {\n    const target = computeInstanceStatus(now, new Date(inst.cutoffAt), new Date(inst.serviceEndAt));\n    if (inst.status !== target) {\n      await client.mealInstance.update({ where: { id: inst.id }, data: { status: target } });\n      updatedInstances++;\n    }\n  }''',
    '''  for (const inst of instances) {\n    const effectiveLockAt = computeMealLockAt(new Date(inst.cutoffAt), new Date(inst.serviceStartAt));\n    const target = computeInstanceStatus(\n      now,\n      effectiveLockAt,\n      new Date(inst.serviceStartAt),\n      new Date(inst.serviceEndAt)\n    );\n    if (inst.status !== target || new Date(inst.lockAt).getTime() !== effectiveLockAt.getTime()) {\n      await client.mealInstance.update({\n        where: { id: inst.id },\n        data: { status: target, lockAt: effectiveLockAt },\n      });\n      updatedInstances++;\n    }\n  }''',
)

# New definitions cannot put the declared same-day cutoff after service begins.
patch(
    "src/lib/domain/meal-definition-schema.ts",
    '''  cutoffStrategy?: string;\n  cutoffOffsetDays?: number | null;\n}):''',
    '''  cutoffStrategy?: string;\n  cutoffOffsetDays?: number | null;\n  cutoffLocalTime?: string;\n}):''',
)
patch(
    "src/lib/domain/meal-definition-schema.ts",
    '''  if (cfg.cutoffStrategy === "CUSTOM_OFFSET" && (cfg.cutoffOffsetDays == null || cfg.cutoffOffsetDays < 0)) {\n    fields.cutoffOffsetDays = "Enter the cutoff offset in days (0-30).";\n  }\n\n  return { fields, fixedPriceMinorParsed };''',
    '''  if (cfg.cutoffStrategy === "CUSTOM_OFFSET" && (cfg.cutoffOffsetDays == null || cfg.cutoffOffsetDays < 0)) {\n    fields.cutoffOffsetDays = "Enter the cutoff offset in days (0-30).";\n  }\n\n  const sameDayCutoff =\n    cfg.cutoffStrategy === "SAME_DAY" ||\n    (cfg.cutoffStrategy === "CUSTOM_OFFSET" && (cfg.cutoffOffsetDays ?? 0) === 0);\n  if (\n    sameDayCutoff &&\n    cfg.cutoffLocalTime &&\n    cfg.serviceStartLocal &&\n    cfg.cutoffLocalTime > cfg.serviceStartLocal\n  ) {\n    fields.cutoffLocalTime = "Same-day cutoff cannot be after service starts.";\n  }\n\n  return { fields, fixedPriceMinorParsed };''',
)

# Admin overrides are server-time lock decisions, never inferred from a stale status string.
for route in [
    "src/app/api/v1/admin/meals/[instanceId]/override/route.ts",
    "src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts",
]:
    p = ROOT / route
    text = p.read_text()
    old = 'const cutoffPassed = instance.status !== "OPEN" || now.getTime() >= instance.cutoffAt.getTime();' if "guest-override" not in route else 'const isLocked = instance.status !== "OPEN" || now.getTime() >= instance.cutoffAt.getTime();'
    new = 'const cutoffPassed = now.getTime() >= instance.lockAt.getTime();' if "guest-override" not in route else 'const isLocked = now.getTime() >= instance.lockAt.getTime();'
    assert text.count(old) == 1, f"{route}: cutoff guard drifted"
    text = text.replace(old, new, 1)
    p.write_text(text)

# Resident toggles also use the authoritative lockAt, and cancelled service is terminal.
p = ROOT / "src/app/api/v1/meals/[instanceId]/toggle/route.ts"
text = p.read_text()
old = '''    const now = new Date();\n    // Server-time cutoff — the browser countdown is decoration only (spec §16).\n    if (now.getTime() >= instance.cutoffAt.getTime()) {'''
new = '''    const now = new Date();\n    if (instance.status === "CANCELLED") {\n      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);\n    }\n    // Server-time lock instant — never later than service start.\n    if (now.getTime() >= instance.lockAt.getTime()) {'''
assert text.count(old) == 1
text = text.replace(old, new, 1)
text = text.replace('formatTimeLabel(instance.cutoffAt, tz)', 'formatTimeLabel(instance.lockAt, tz)', 1)
p.write_text(text)

# Guest lifecycle uses the same lock instant as resident meals.
p = ROOT / "src/lib/domain/guest-meal-lifecycle.ts"
text = p.read_text()
text = text.replace('  cutoffAt: Date,\n  serviceEndAt: Date,', '  lockAt: Date,\n  serviceEndAt: Date,', 1)
text = text.replace('now.getTime() >= cutoffAt.getTime()', 'now.getTime() >= lockAt.getTime()', 1)
text = text.replace('mealInstance: { select: { cutoffAt: true, serviceEndAt: true } }', 'mealInstance: { select: { lockAt: true, serviceEndAt: true } }', 1)
text = text.replace('      row.mealInstance.cutoffAt,\n      row.mealInstance.serviceEndAt,', '      row.mealInstance.lockAt,\n      row.mealInstance.serviceEndAt,', 1)
text = text.replace('row.lockedAt ?? row.mealInstance.cutoffAt', 'row.lockedAt ?? row.mealInstance.lockAt')
p.write_text(text)

# Guest create/edit/cancel enforce the same lock instant and cancelled meal terminal.
for route in [
    "src/app/api/v1/guest-meals/route.ts",
    "src/app/api/v1/guest-meals/[id]/route.ts",
    "src/app/api/v1/guest-meals/[id]/cancel/route.ts",
]:
    p = ROOT / route
    text = p.read_text()
    if route.endswith("guest-meals/route.ts"):
        old = '''    const now = new Date();\n    if (now.getTime() >= instance.cutoffAt.getTime()) {'''
        new = '''    const now = new Date();\n    if (instance.status === "CANCELLED") {\n      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);\n    }\n    if (now.getTime() >= instance.lockAt.getTime()) {'''
        assert text.count(old) == 1, route
        text = text.replace(old, new, 1)
        text = text.replace('formatTimeLabel(instance.cutoffAt, tz)', 'formatTimeLabel(instance.lockAt, tz)', 1)
    else:
        old = '''  const now = new Date();\n  if (now.getTime() >= guest.mealInstance.cutoffAt.getTime()) {'''
        new = '''  const now = new Date();\n  if (guest.mealInstance.status === "CANCELLED") {\n    throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);\n  }\n  if (now.getTime() >= guest.mealInstance.lockAt.getTime()) {'''
        assert text.count(old) == 1, route
        text = text.replace(old, new, 1)
        text = text.replace('formatTimeLabel(guest.mealInstance.cutoffAt, tz)', 'formatTimeLabel(guest.mealInstance.lockAt, tz)', 1)
    p.write_text(text)

# Admin overrides cannot mutate a cancelled meal service.
for route in [
    "src/app/api/v1/admin/meals/[instanceId]/override/route.ts",
    "src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts",
]:
    p = ROOT / route
    text = p.read_text()
    needle = '    const now = new Date();\n'
    assert text.count(needle) >= 1, route
    replacement = '''    const now = new Date();\n    if (instance.status === "CANCELLED") {\n      throw new ApiError(CODES.MEAL_NOT_AVAILABLE, "This meal service was cancelled.", 409);\n    }\n'''
    text = text.replace(needle, replacement, 1)
    p.write_text(text)

# Unit temporal state coverage.
p = ROOT / "tests/unit/meal-state.test.ts"
text = p.read_text()
old = '''  test("instance status transitions are driven by authoritative timestamps", () => {\n    const cutoff = new Date("2026-09-05T10:00:00.000Z");\n    const end = new Date("2026-09-05T12:00:00.000Z");\n\n    expect(computeInstanceStatus(new Date("2026-09-05T09:59:59.000Z"), cutoff, end)).toBe("OPEN");\n    expect(computeInstanceStatus(new Date("2026-09-05T10:00:00.000Z"), cutoff, end)).toBe("LOCKED");\n    expect(computeInstanceStatus(new Date("2026-09-05T12:00:00.000Z"), cutoff, end)).toBe("COMPLETED");\n  });'''
new = '''  test("instance status transitions are driven by authoritative timestamps", () => {\n    const lockAt = new Date("2026-09-05T10:00:00.000Z");\n    const start = new Date("2026-09-05T11:00:00.000Z");\n    const end = new Date("2026-09-05T12:00:00.000Z");\n\n    expect(computeInstanceStatus(new Date("2026-09-05T09:59:59.000Z"), lockAt, start, end)).toBe("OPEN");\n    expect(computeInstanceStatus(new Date("2026-09-05T10:00:00.000Z"), lockAt, start, end)).toBe("LOCKED");\n    expect(computeInstanceStatus(new Date("2026-09-05T11:00:00.000Z"), lockAt, start, end)).toBe("SERVICE_ACTIVE");\n    expect(computeInstanceStatus(new Date("2026-09-05T12:00:00.000Z"), lockAt, start, end)).toBe("COMPLETED");\n  });'''
assert text.count(old) == 1
p.write_text(text.replace(old, new, 1))

# Migration normalizes all existing non-cancelled temporal states and lockAt.
migration = ROOT / "prisma/migrations/20260906_090000_meal_instance_temporal_lifecycle/migration.sql"
migration.parent.mkdir(parents=True, exist_ok=True)
migration.write_text('''-- Phase 48: align persisted MealInstance state with the actual temporal lifecycle.\nALTER TABLE "MealInstance" ALTER COLUMN "status" SET DEFAULT 'OPEN';\n\nUPDATE "MealInstance"\nSET\n  "lockAt" = LEAST("cutoffAt", "serviceStartAt"),\n  "status" = CASE\n    WHEN CURRENT_TIMESTAMP >= "serviceEndAt" THEN 'COMPLETED'\n    WHEN CURRENT_TIMESTAMP >= "serviceStartAt" THEN 'SERVICE_ACTIVE'\n    WHEN CURRENT_TIMESTAMP >= LEAST("cutoffAt", "serviceStartAt") THEN 'LOCKED'\n    ELSE 'OPEN'\n  END\nWHERE "status" <> 'CANCELLED';\n''')

# PostgreSQL regression for persisted state and CANCELLED terminal behavior.
test = ROOT / "tests/integration/meal-instance-temporal-lifecycle.test.ts"
test.write_text('''import { afterAll, describe, expect, test } from "bun:test";\nimport { db } from "@/lib/db";\nimport { refreshAndLock } from "@/lib/domain/meal-engine";\n\nfunction unique(prefix: string): string {\n  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;\n}\n\nasync function createInstance(\n  institutionId: string,\n  label: string,\n  serviceDate: Date,\n  lockAt: Date,\n  serviceStartAt: Date,\n  serviceEndAt: Date,\n  status: string\n) {\n  const definition = await db.mealDefinition.create({\n    data: { institutionId, name: unique(label) },\n  });\n  const version = await db.mealDefinitionVersion.create({\n    data: { mealDefinitionId: definition.id, version: 1, configSnapshotJson: "{}" },\n  });\n  return db.mealInstance.create({\n    data: {\n      institutionId,\n      mealDefinitionId: definition.id,\n      mealDefinitionVersionId: version.id,\n      serviceDate,\n      serviceStartAt,\n      serviceEndAt,\n      cutoffAt: lockAt,\n      lockAt,\n      status,\n    },\n  });\n}\n\nafterAll(async () => {\n  await db.$disconnect();\n});\n\ndescribe("meal instance temporal lifecycle", () => {\n  test("refresh persists LOCKED, SERVICE_ACTIVE, COMPLETED and preserves CANCELLED", async () => {\n    const institution = await db.institution.create({ data: { name: unique("Temporal Mess"), timezone: "UTC" } });\n    const now = new Date();\n    const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));\n    const minute = 60_000;\n\n    const locked = await createInstance(\n      institution.id, "Locked", serviceDate,\n      new Date(now.getTime() - 10 * minute), new Date(now.getTime() + 10 * minute), new Date(now.getTime() + 30 * minute), "OPEN"\n    );\n    const active = await createInstance(\n      institution.id, "Active", serviceDate,\n      new Date(now.getTime() - 20 * minute), new Date(now.getTime() - 5 * minute), new Date(now.getTime() + 20 * minute), "LOCKED"\n    );\n    const completed = await createInstance(\n      institution.id, "Completed", serviceDate,\n      new Date(now.getTime() - 60 * minute), new Date(now.getTime() - 30 * minute), new Date(now.getTime() - minute), "LOCKED"\n    );\n    const cancelled = await createInstance(\n      institution.id, "Cancelled", serviceDate,\n      new Date(now.getTime() - 60 * minute), new Date(now.getTime() - 30 * minute), new Date(now.getTime() - minute), "CANCELLED"\n    );\n\n    const key = serviceDate.toISOString().slice(0, 10);\n    await refreshAndLock(institution.id, "UTC", null, key, key);\n\n    const rows = await db.mealInstance.findMany({ where: { id: { in: [locked.id, active.id, completed.id, cancelled.id] } } });\n    const status = new Map(rows.map((row) => [row.id, row.status]));\n    expect(status.get(locked.id)).toBe("LOCKED");\n    expect(status.get(active.id)).toBe("SERVICE_ACTIVE");\n    expect(status.get(completed.id)).toBe("COMPLETED");\n    expect(status.get(cancelled.id)).toBe("CANCELLED");\n  });\n});\n''')

# Source regression guards the dead-state removal and server-time lock checks.
source_test = ROOT / "tests/unit/meal-instance-temporal-lifecycle-source.test.ts"
source_test.write_text('''import { describe, expect, test } from "bun:test";\n\nconst schema = await Bun.file("prisma/schema.prisma").text();\nconst engine = await Bun.file("src/lib/domain/meal-engine.ts").text();\nconst override = await Bun.file("src/app/api/v1/admin/meals/[instanceId]/override/route.ts").text();\nconst guestOverride = await Bun.file("src/app/api/v1/admin/meals/[instanceId]/guest-override/route.ts").text();\nconst toggle = await Bun.file("src/app/api/v1/meals/[instanceId]/toggle/route.ts").text();\nconst definitionSchema = await Bun.file("src/lib/domain/meal-definition-schema.ts").text();\n\ndescribe("meal instance temporal lifecycle source contracts", () => {\n  test("live schema no longer defaults to the unreachable SCHEDULED state", () => {\n    expect(schema).toContain('status                  String   @default("OPEN") // OPEN | LOCKED | SERVICE_ACTIVE | COMPLETED | CANCELLED');\n    expect(engine).toContain('return "SERVICE_ACTIVE"');\n    expect(engine).toContain('status: { not: "CANCELLED" }');\n  });\n\n  test("admin override eligibility uses authoritative lockAt rather than status != OPEN", () => {\n    expect(override).toContain("now.getTime() >= instance.lockAt.getTime()");\n    expect(guestOverride).toContain("now.getTime() >= instance.lockAt.getTime()");\n    expect(override).not.toContain('instance.status !== "OPEN"');\n    expect(guestOverride).not.toContain('instance.status !== "OPEN"');\n  });\n\n  test("cancelled meal service is terminal for resident and admin mutation routes", () => {\n    expect(toggle).toContain('instance.status === "CANCELLED"');\n    expect(override).toContain('instance.status === "CANCELLED"');\n    expect(guestOverride).toContain('instance.status === "CANCELLED"');\n  });\n\n  test("same-day cutoff cannot be configured after service start", () => {\n    expect(definitionSchema).toContain("Same-day cutoff cannot be after service starts.");\n    expect(definitionSchema).toContain("cfg.cutoffLocalTime > cfg.serviceStartLocal");\n  });\n});\n''')
