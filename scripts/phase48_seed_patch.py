from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
seed = ROOT / "scripts/seed.ts"
text = seed.read_text()
old = '''    const cutoffAt = computeCutoffAt(dateKey, defRow.def.cutoffLocalTime, 0, TZ);\n    const window = computeServiceWindow(dateKey, defRow.def.serviceStartLocal, defRow.def.serviceEndLocal, TZ);\n    const status = now < cutoffAt ? "OPEN" : "LOCKED";\n    return db.mealInstance.create({'''
new = '''    const cutoffAt = computeCutoffAt(dateKey, defRow.def.cutoffLocalTime, 0, TZ);\n    const window = computeServiceWindow(dateKey, defRow.def.serviceStartLocal, defRow.def.serviceEndLocal, TZ);\n    const lockAt = new Date(Math.min(cutoffAt.getTime(), window.startAt.getTime()));\n    const status =\n      now.getTime() >= window.endAt.getTime()\n        ? "COMPLETED"\n        : now.getTime() >= window.startAt.getTime()\n          ? "SERVICE_ACTIVE"\n          : now.getTime() >= lockAt.getTime()\n            ? "LOCKED"\n            : "OPEN";\n    return db.mealInstance.create({'''
assert text.count(old) == 1, "seed instance status block drifted"
text = text.replace(old, new, 1)
old2 = '''        cutoffAt,\n        lockAt: cutoffAt,\n        status,'''
new2 = '''        cutoffAt,\n        lockAt,\n        status,'''
assert text.count(old2) == 1, "seed lockAt block drifted"
seed.write_text(text.replace(old2, new2, 1))

source = ROOT / "tests/unit/meal-instance-temporal-lifecycle-source.test.ts"
s = source.read_text()
needle = '''  test("same-day cutoff cannot be configured after service start", () => {\n    expect(definitionSchema).toContain("Same-day cutoff cannot be after service starts.");\n    expect(definitionSchema).toContain("cfg.cutoffLocalTime > cfg.serviceStartLocal");\n  });\n});\n'''
replacement = '''  test("same-day cutoff cannot be configured after service start", () => {\n    expect(definitionSchema).toContain("Same-day cutoff cannot be after service starts.");\n    expect(definitionSchema).toContain("cfg.cutoffLocalTime > cfg.serviceStartLocal");\n  });\n\n  test("development seed persists the same temporal states instead of stale LOCKED rows", async () => {\n    const seed = await Bun.file("scripts/seed.ts").text();\n    expect(seed).toContain('? "SERVICE_ACTIVE"');\n    expect(seed).toContain('? "COMPLETED"');\n    expect(seed).toContain("const lockAt = new Date(Math.min(cutoffAt.getTime(), window.startAt.getTime()))");\n  });\n});\n'''
assert s.count(needle) == 1, "source test tail drifted"
source.write_text(s.replace(needle, replacement, 1))
