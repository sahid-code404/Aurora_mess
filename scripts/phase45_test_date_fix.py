from pathlib import Path

p = Path(__file__).resolve().parents[1] / "tests/integration/refund-correction-lifecycle.test.ts"
text = p.read_text()
replacements = {
    'dueDate: new Date("2026-02-15T00:00:00.000Z"),': 'dueDate: new Date(Date.now() + 30 * 86_400_000),',
    'dueDate: new Date("2026-03-15T00:00:00.000Z"),': 'dueDate: new Date(Date.now() + 60 * 86_400_000),',
    'dueDate: new Date("2026-04-15T00:00:00.000Z"),': 'dueDate: new Date(Date.now() + 30 * 86_400_000),',
    'dueDate: new Date("2026-05-15T00:00:00.000Z"),': 'dueDate: new Date(Date.now() + 30 * 86_400_000),',
}
for old, new in replacements.items():
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match for {old!r}, found {count}")
    text = text.replace(old, new, 1)
p.write_text(text)
print("Phase 45 integration due dates made clock-stable")
