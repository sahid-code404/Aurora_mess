from pathlib import Path

path = Path('src/lib/domain/billing.ts')
text = path.read_text()

text = text.replace(
    'import { isBillPastDueDate } from "./bill-status";\n',
    'import { isBillPastDueDate } from "./bill-status";\nimport { refreshGuestMealLifecycle } from "./guest-meal-lifecycle";\n',
    1,
)
text = text.replace(
    'const GUEST_CONFIRMED = ["CONFIRMED", "CONSUMED"];',
    'const GUEST_CONFIRMED = ["CONFIRMED", "LOCKED", "CONSUMED"];',
    1,
)
needle = '  const serviceDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };\n  const checks: ReadinessCheck[] = [];\n'
replacement = '''  const serviceDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };\n\n  // Billing is a lifecycle boundary: persist every ended guest booking as\n  // CONSUMED before formula variables/readiness/snapshots are resolved. This\n  // must not depend on whether a Resident/Admin happened to open a guest page.\n  await refreshGuestMealLifecycle({\n    institutionId: period.institutionId,\n    from: bounds.startAt,\n    to: new Date(bounds.endExclusiveAt.getTime() - 1),\n    client,\n  });\n\n  const checks: ReadinessCheck[] = [];\n'''
if needle not in text:
    raise SystemExit('computeReadiness insertion point not found')
text = text.replace(needle, replacement, 1)
path.write_text(text)
print('Phase 24 billing lifecycle patch applied')
