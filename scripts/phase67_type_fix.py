from pathlib import Path

path = Path("src/lib/domain/formula/versions.ts")
text = path.read_text()
old = "    const periodVersion = selectFormulaVersionAt(def.versions, targetPeriodStart);"
new = "    const periodVersion: any = selectFormulaVersionAt(def.versions, targetPeriodStart);"
if text.count(old) != 1:
    raise SystemExit(f"expected exactly one target, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
print("Phase 67 type fix applied")
