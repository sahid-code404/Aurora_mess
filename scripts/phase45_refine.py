from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# Invalid persisted refund states must never be created implicitly.
replace_once(
    "prisma/schema.prisma",
    '  status            String    @default("PENDING") // COMPLETED | VOIDED; PROCESSING is transaction-internal, legacy PENDING/FAILED are invalid',
    '  status            String // COMPLETED | VOIDED; PROCESSING is transaction-internal, legacy PENDING/FAILED are invalid',
)
replace_once(
    "prisma/migrations/20260906_070000_add_refund_correction_lifecycle/migration.sql",
    'ALTER TABLE "Refund"\n  ADD COLUMN "reversalJournalId" TEXT,',
    'ALTER TABLE "Refund"\n  ALTER COLUMN "status" DROP DEFAULT,\n  ADD COLUMN "reversalJournalId" TEXT,',
)

# A completed row carrying prior correction provenance is corrupted/ambiguous;
# never overwrite that evidence with a second correction attempt.
replace_once(
    "src/lib/domain/refund-correction.ts",
    '''    if (refund.status !== "COMPLETED") {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "Only completed refunds can be voided.", 409);
    }

    let reversalJournalId: string | null = null;''',
    '''    if (refund.status !== "COMPLETED") {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "Only completed refunds can be voided.", 409);
    }
    if (refund.reversalJournalId || refund.voidReason || refund.voidedByUserId || refund.voidedAt) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This completed refund already carries correction metadata and cannot be voided safely.",
        409
      );
    }

    let reversalJournalId: string | null = null;''',
)
replace_once(
    "src/lib/domain/refund-correction.ts",
    '''    } else if (refund.mode === "CARRY_FORWARD") {
      if (refund.journalId) {''',
    '''    } else if (refund.mode === "CARRY_FORWARD") {
      if (refund.journalId || refund.reversalJournalId) {''',
)

# Reversed journals are loaded for refund-correction verification, but a bill
# still counts as journaled only when its BILL journal is POSTED.
replace_once(
    "src/lib/domain/ledger.ts",
    '''  for (const journal of journals) {
    if (journal.refType === "BILL" && journal.refId && billIds.has(journal.refId)) {''',
    '''  for (const journal of journals) {
    if (journal.status === "POSTED" && journal.refType === "BILL" && journal.refId && billIds.has(journal.refId)) {''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    ''' * exact journal row still exists, is POSTED, belongs to the institution, and is
 * typed REFUND. New refunds are always linked by refundId.''',
    ''' * exact journal row still exists, has the lifecycle-appropriate journal status,
 * belongs to the institution, and is typed REFUND. New refunds are always linked by refundId.''',
)

# Admin Refund History must visibly explain a correction instead of continuing
# to present the original issuance reason as if the payout were still active.
replace_once(
    "src/components/app/admin/payments.tsx",
    '''                          <span className="kpi-num text-[11px] text-muted-foreground truncate max-w-[200px]" title={ref.reason}>
                            {ref.reason}
                          </span>''',
    '''                          <span
                            className="kpi-num text-[11px] text-muted-foreground truncate max-w-[200px]"
                            title={ref.status === "VOIDED" ? ref.voidReason ?? ref.reason : ref.reason}
                          >
                            {ref.status === "VOIDED" ? `Corrected: ${ref.voidReason ?? "Administrative correction"}` : ref.reason}
                          </span>''',
)
replace_once(
    "src/components/app/admin/payments.tsx",
    '''                            {ref.mode === "ISSUE_REFUND" ? "payout" : "carried forward"}''',
    '''                            {ref.status === "VOIDED" ? "corrected" : ref.mode === "ISSUE_REFUND" ? "payout" : "carried forward"}''',
)

print("Phase 45 refinements applied")
