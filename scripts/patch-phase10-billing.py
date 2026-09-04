from pathlib import Path

path = Path("src/lib/domain/billing.ts")
text = path.read_text()

text = text.replace('import { createHash } from "node:crypto";\n', '')
text = text.replace(
    'import { postJournal, type JournalLine } from "./ledger";',
    'import { postJournal, reconcileInstitution, type JournalLine } from "./ledger";'
)
text = text.replace(
    'import { resolveFormulaVersionForPeriod } from "./formula/versions";',
    'import { resolveFormulaVersionForPeriod } from "./formula/versions";\nimport { billingSnapshotChecksum } from "./billing-integrity";'
)

start = text.index('  // 5. Ledger reconciled with approved records (mirrors reconcileInstitution).')
end = text.index('  // 6. No duplicate resident meals', start)
replacement = '''  // 5. One authoritative reconciliation kernel shared with the ledger view.\n  //    This includes refunds, reversal links, bill journals, and journal shape.\n  const reconciliation = await reconcileInstitution(period.institutionId, client);\n  checks.push({\n    key: "ledger_reconciled",\n    label: "Ledger reconciled with financial records",\n    pass: reconciliation.balanced,\n    detail: reconciliation.problems.length > 0 ? reconciliation.problems.join("; ") : undefined,\n  });\n\n'''
text = text[:start] + replacement + text[end:]

old_checksum = '    const checksum = createHash("sha256").update(JSON.stringify(JSON.parse(payloadJson))).digest("hex");'
if old_checksum not in text:
    raise SystemExit('checksum anchor missing')
text = text.replace(old_checksum, '    const checksum = billingSnapshotChecksum(payloadJson);', 1)

old_detail = '''    const formulaDetail = {\n      period: { year: period.year, month: period.month, startKey: bounds.startKey, endKey: bounds.endKey },\n      formula: {\n        version: formulaVersion.version,\n        expressionSource: formulaVersion.expressionSource,\n        humanPreview: formulaVersion.humanPreview,\n      },\n    };'''
new_detail = '''    const formulaDetail = {\n      period: { year: period.year, month: period.month, startKey: bounds.startKey, endKey: bounds.endKey },\n      snapshot: { id: snapshot.id, checksum },\n      formula: {\n        versionId: formulaVersion.id,\n        version: formulaVersion.version,\n        checksum: formulaVersion.checksum,\n        expressionSource: formulaVersion.expressionSource,\n        humanPreview: formulaVersion.humanPreview,\n      },\n    };'''
if old_detail not in text:
    raise SystemExit('formula detail anchor missing')
text = text.replace(old_detail, new_detail, 1)

rollback_start = text.index('// ---------------------------------------------------------------------------\n// ROLLBACK / REMOVE PERIOD BILLS')
auto_start = text.index('// ---------------------------------------------------------------------------\n// AUTOMATIC BILL GENERATION', rollback_start)
safe_reset = '''// ---------------------------------------------------------------------------\n// LEGACY DESTRUCTIVE RESET — intentionally disabled\n// ---------------------------------------------------------------------------\n\n/**\n * Kept only as a compatibility symbol for any older internal caller. Posted\n * billing journals and generated historical artifacts are immutable: correction\n * must use reopen + bill adjustments / reversal journals, never physical delete.\n */\nexport async function removePeriodBills(\n  periodId: string,\n  actorUserId = "SYSTEM"\n): Promise<{ removedCount: number; periodId: string }> {\n  void actorUserId;\n  const period = await db.billingPeriod.findUnique({ where: { id: periodId } });\n  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);\n  throw new ApiError(\n    CODES.BILLING_PERIOD_CLOSED,\n    "Destructive billing reset is disabled. Generated bills, snapshots, and posted journals are immutable; use reopen plus audited bill adjustments or reversal journals for corrections.",\n    409\n  );\n}\n\n'''
text = text[:rollback_start] + safe_reset + text[auto_start:]

path.write_text(text)
