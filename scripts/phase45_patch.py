from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one regex match, found {count}: {pattern[:120]!r}")
    write(path, updated)


# ---------------------------------------------------------------------------
# Prisma: refund correction provenance + useful lifecycle index.
# ---------------------------------------------------------------------------
replace_once(
    "prisma/schema.prisma",
    '''  status          String    @default("PENDING") // PENDING | PROCESSING | COMPLETED | FAILED | VOIDED
  journalId       String?
  createdByUserId String
  createdAt       DateTime  @default(now())
  completedAt     DateTime?

  payment Payment? @relation(fields: [paymentId], references: [id])
}''',
    '''  status            String    @default("PENDING") // COMPLETED | VOIDED; PROCESSING is transaction-internal, legacy PENDING/FAILED are invalid
  journalId         String?
  reversalJournalId String?
  createdByUserId   String
  createdAt         DateTime  @default(now())
  completedAt       DateTime?
  voidReason        String?
  voidedByUserId    String?
  voidedAt          DateTime?

  payment Payment? @relation(fields: [paymentId], references: [id])

  @@index([institutionId, residentId, status])
}''',
)
replace_once(
    "prisma/migrations/20260906_070000_add_refund_correction_lifecycle/migration.sql",
    '''  ADD COLUMN "voidedByUserId" TEXT,
  ADD COLUMN "voidedAt" TIMESTAMP(3);
''',
    '''  ADD COLUMN "voidedByUserId" TEXT,
  ADD COLUMN "voidedAt" TIMESTAMP(3);

CREATE INDEX "Refund_institutionId_residentId_status_idx"
  ON "Refund"("institutionId", "residentId", "status");
''',
)

# ---------------------------------------------------------------------------
# Explicit lifecycle error + serialized correction provenance.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/errors.ts",
    '''  REFUND_NOT_ELIGIBLE: "REFUND_NOT_ELIGIBLE",
  INSUFFICIENT_REFUND_CREDIT: "INSUFFICIENT_REFUND_CREDIT",''',
    '''  REFUND_NOT_ELIGIBLE: "REFUND_NOT_ELIGIBLE",
  REFUND_INVALID_STATE: "REFUND_INVALID_STATE",
  INSUFFICIENT_REFUND_CREDIT: "INSUFFICIENT_REFUND_CREDIT",''',
)
replace_once(
    "src/lib/domain/serialize.ts",
    '''    paymentId: r.paymentId ?? null,
    journalId: r.journalId ?? null,
    residentId: r.residentId,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
''',
    '''    paymentId: r.paymentId ?? null,
    journalId: r.journalId ?? null,
    reversalJournalId: r.reversalJournalId ?? null,
    voidReason: r.voidReason ?? null,
    voidedByUserId: r.voidedByUserId ?? null,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
    residentId: r.residentId,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
''',
)

# ---------------------------------------------------------------------------
# Refund correction domain: explicit state errors + immediate bill settlement.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/domain/refund-correction.ts",
    '''import { postJournal } from "@/lib/domain/ledger";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";''',
    '''import { postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement } from "@/lib/domain/funds";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";''',
)
replace_once(
    "src/lib/domain/refund-correction.ts",
    '''      throw new ApiError(CODES.REFUND_NOT_ELIGIBLE, "This refund was already voided.", 409);
    }
    if (refund.status !== "COMPLETED") {
      throw new ApiError(CODES.REFUND_NOT_ELIGIBLE, "Only completed refunds can be voided.", 409);''',
    '''      throw new ApiError(CODES.REFUND_INVALID_STATE, "This refund was already voided.", 409);
    }
    if (refund.status !== "COMPLETED") {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "Only completed refunds can be voided.", 409);''',
)
replace_once(
    "src/lib/domain/refund-correction.ts",
    '''    if (guard.count !== 1) {
      throw new ApiError(CODES.REFUND_NOT_ELIGIBLE, "This refund was already changed.", 409);
    }

    await appendAudit(''',
    '''    if (guard.count !== 1) {
      throw new ApiError(CODES.REFUND_INVALID_STATE, "This refund was already changed.", 409);
    }

    // A reversed cash payout restores resident credit. Re-run the same FIFO
    // settlement kernel used by payment mutations immediately so newer bills
    // cannot remain due while Funds already exposes the restored credit.
    const settlement =
      refund.mode === "ISSUE_REFUND"
        ? await recomputeBillSettlement(tx, refund.residentId)
        : { changedBills: 0, unappliedMinor: 0 };

    await appendAudit(''',
)
replace_once(
    "src/lib/domain/refund-correction.ts",
    '''          originalJournalId: refund.journalId,
          reversalJournalId,
        },''',
    '''          originalJournalId: refund.journalId,
          reversalJournalId,
          settledBills: settlement.changedBills,
          unappliedMinor: settlement.unappliedMinor,
        },''',
)

# ---------------------------------------------------------------------------
# Reconciliation: completed + voided refund lifecycle is fully auditable.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/domain/ledger.ts",
    '''  refundLegacyReferenceWarnings: number;
  carryForwardsWithJournal: number;
  billsWithoutJournal: number;''',
    '''  refundLegacyReferenceWarnings: number;
  carryForwardsWithJournal: number;
  voidedCashRefundsWithoutReversalJournal: number;
  refundReversalLinkMismatches: number;
  voidedCarryForwardsWithJournal: number;
  refundInvalidLifecycleRows: number;
  billsWithoutJournal: number;''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    '''  status: string;
  entries: { debitMinor: number; creditMinor: number }[];''',
    '''  status: string;
  reversedByJournalId: string | null;
  entries: { debitMinor: number; creditMinor: number }[];''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    '''    client.refund.findMany({
      where: { institutionId, status: "COMPLETED" },
      select: { id: true, mode: true, paymentId: true, journalId: true },
    }),''',
    '''    client.refund.findMany({
      where: { institutionId },
      select: {
        id: true,
        mode: true,
        status: true,
        paymentId: true,
        journalId: true,
        reversalJournalId: true,
      },
    }),''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    '''    client.ledgerJournal.findMany({
      where: { institutionId, status: "POSTED" },
      include: { entries: { select: { debitMinor: true, creditMinor: true } } },
    }),''',
    '''    client.ledgerJournal.findMany({
      where: { institutionId, status: { in: ["POSTED", "REVERSED"] } },
      include: { entries: { select: { debitMinor: true, creditMinor: true } } },
    }),''',
)
regex_once(
    "src/lib/domain/ledger.ts",
    r'''  let cashRefundsWithoutJournal = 0;\n.*?\n  const billIds = new Set''',
    '''  let cashRefundsWithoutJournal = 0;
  let refundJournalLinkMismatches = 0;
  let refundLegacyReferenceWarnings = 0;
  let carryForwardsWithJournal = 0;
  let voidedCashRefundsWithoutReversalJournal = 0;
  let refundReversalLinkMismatches = 0;
  let voidedCarryForwardsWithJournal = 0;
  let refundInvalidLifecycleRows = 0;

  for (const refund of refunds as any[]) {
    if (refund.status !== "COMPLETED" && refund.status !== "VOIDED") {
      refundInvalidLifecycleRows += 1;
      continue;
    }

    if (refund.mode === "CARRY_FORWARD") {
      if (refund.status === "COMPLETED" && refund.journalId) carryForwardsWithJournal += 1;
      if (refund.status === "VOIDED" && (refund.journalId || refund.reversalJournalId)) {
        voidedCarryForwardsWithJournal += 1;
      }
      continue;
    }

    if (refund.mode !== "ISSUE_REFUND") {
      refundInvalidLifecycleRows += 1;
      continue;
    }

    if (!refund.journalId) {
      cashRefundsWithoutJournal += 1;
      if (refund.status === "VOIDED" && !refund.reversalJournalId) {
        voidedCashRefundsWithoutReversalJournal += 1;
      }
      continue;
    }

    const originalJournal = journalById.get(refund.journalId);
    const legacyRefMatches =
      originalJournal?.refId == null ||
      (refund.paymentId != null && originalJournal?.refId === refund.paymentId);
    const referenceMatches = originalJournal?.refId === refund.id || legacyRefMatches;
    const expectedOriginalStatus = refund.status === "VOIDED" ? "REVERSED" : "POSTED";

    if (
      !originalJournal ||
      originalJournal.institutionId !== institutionId ||
      originalJournal.status !== expectedOriginalStatus ||
      originalJournal.refType !== "REFUND" ||
      !referenceMatches
    ) {
      refundJournalLinkMismatches += 1;
      continue;
    }

    if (originalJournal.refId !== refund.id && legacyRefMatches) {
      refundLegacyReferenceWarnings += 1;
    }

    if (refund.status === "COMPLETED") {
      if (originalJournal.reversedByJournalId != null || refund.reversalJournalId != null) {
        refundReversalLinkMismatches += 1;
      }
      continue;
    }

    if (!refund.reversalJournalId) {
      voidedCashRefundsWithoutReversalJournal += 1;
      continue;
    }

    const reversalJournal = journalById.get(refund.reversalJournalId);
    if (
      originalJournal.reversedByJournalId !== refund.reversalJournalId ||
      !linkedJournalMatches(reversalJournal, institutionId, "REFUND", refund.id)
    ) {
      refundReversalLinkMismatches += 1;
    }
  }

  const billIds = new Set''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    '''    carryForwardsWithJournal > 0 ? `${carryForwardsWithJournal} carry-forward refund(s) incorrectly posted to the ledger` : null,
    billsWithoutJournal > 0 ? `${billsWithoutJournal} non-zero bill(s) without a journal` : null,''',
    '''    carryForwardsWithJournal > 0 ? `${carryForwardsWithJournal} carry-forward refund(s) incorrectly posted to the ledger` : null,
    voidedCashRefundsWithoutReversalJournal > 0
      ? `${voidedCashRefundsWithoutReversalJournal} voided cash refund(s) without a reversal journal`
      : null,
    refundReversalLinkMismatches > 0
      ? `${refundReversalLinkMismatches} refund reversal journal link mismatch(es)`
      : null,
    voidedCarryForwardsWithJournal > 0
      ? `${voidedCarryForwardsWithJournal} voided carry-forward refund(s) incorrectly linked to ledger journals`
      : null,
    refundInvalidLifecycleRows > 0
      ? `${refundInvalidLifecycleRows} refund row(s) use an unsupported persisted lifecycle state or mode`
      : null,
    billsWithoutJournal > 0 ? `${billsWithoutJournal} non-zero bill(s) without a journal` : null,''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    '''    carryForwardsWithJournal,
    billsWithoutJournal,''',
    '''    carryForwardsWithJournal,
    voidedCashRefundsWithoutReversalJournal,
    refundReversalLinkMismatches,
    voidedCarryForwardsWithJournal,
    refundInvalidLifecycleRows,
    billsWithoutJournal,''',
)
replace_once(
    "src/lib/domain/ledger.ts",
    '''    unbalancedJournals > 0 ? `${unbalancedJournals} unbalanced posted journal(s)` : null,
    journalsWithoutEntries > 0 ? `${journalsWithoutEntries} posted journal(s) without entries` : null,''',
    '''    unbalancedJournals > 0 ? `${unbalancedJournals} unbalanced ledger journal(s)` : null,
    journalsWithoutEntries > 0 ? `${journalsWithoutEntries} ledger journal(s) without entries` : null,''',
)

# ---------------------------------------------------------------------------
# Admin refund API: no dead pending/processing prioritization.
# ---------------------------------------------------------------------------
regex_once(
    "src/app/api/v1/admin/refunds/route.ts",
    r'''  const sortedItems = \[\.\.\.page\.items\]\.sort\(\(a, b\) => \{.*?\n  \}\);''',
    '''  // Refund creation is atomic: only committed COMPLETED / VOIDED rows are
  // externally visible. Preserve the keyset order rather than prioritizing
  // unreachable PENDING / PROCESSING display states.
  const sortedItems = page.items;''',
)

# ---------------------------------------------------------------------------
# Admin Payments: explicit correction action in Refund History.
# ---------------------------------------------------------------------------
replace_once(
    "src/components/app/admin/payments.tsx",
    '''  completedAt: string | null;
}''',
    '''  completedAt: string | null;
  reversalJournalId: string | null;
  voidReason: string | null;
  voidedByUserId: string | null;
  voidedAt: string | null;
}''',
)
replace_once(
    "src/components/app/admin/payments.tsx",
    '''  const [refundTarget, setRefundTarget] = useState<RefundCandidate | null>(null);
  const [acting, setActing] = useState(false);''',
    '''  const [refundTarget, setRefundTarget] = useState<RefundCandidate | null>(null);
  const [refundVoidTarget, setRefundVoidTarget] = useState<RefundRow | null>(null);
  const [refundVoidBusy, setRefundVoidBusy] = useState(false);
  const [acting, setActing] = useState(false);''',
)
replace_once(
    "src/components/app/admin/payments.tsx",
    '''  async function runAction(kind: ReviewAction, reason?: string) {
    if (!reviewId) return;''',
    '''  async function voidRefundRecord(reason?: string) {
    if (!refundVoidTarget || refundVoidBusy) return;
    setRefundVoidBusy(true);
    try {
      await postJson(`/api/v1/admin/refunds/${refundVoidTarget.id}/void`, { reason });
      invalidate([
        "/api/v1/admin/refunds",
        "/api/v1/admin/refunds/eligible",
        PAYMENTS_PATH,
        "/api/v1/admin/funds",
        "/api/v1/admin/dashboard",
        "/api/v1/admin/billing",
      ]);
      toast.success("Refund correction recorded", {
        description:
          refundVoidTarget.mode === "ISSUE_REFUND"
            ? `${refundVoidTarget.residentName} · ${refundVoidTarget.amountFormatted} restored to resident credit`
            : `${refundVoidTarget.residentName} · carry-forward decision reopened`,
      });
      setRefundVoidTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setRefundVoidBusy(false);
    }
  }

  async function runAction(kind: ReviewAction, reason?: string) {
    if (!reviewId) return;''',
)
replace_once(
    "src/components/app/admin/payments.tsx",
    '''                        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <Chip tone={ref.mode === "ISSUE_REFUND" ? "warning" : "frost"} className="text-[10px] px-2 py-0.5 shrink-0">
                            {ref.mode === "ISSUE_REFUND" ? "Payout" : "Carry forward"}
                          </Chip>''',
    '''                        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                          <StatusBadge status={ref.status} />
                          <Chip tone={ref.mode === "ISSUE_REFUND" ? "warning" : "frost"} className="text-[10px] px-2 py-0.5 shrink-0">
                            {ref.mode === "ISSUE_REFUND" ? "Payout" : "Carry forward"}
                          </Chip>''',
)
replace_once(
    "src/components/app/admin/payments.tsx",
    '''                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateTo(`/admin/residents/${ref.residentId}`);
                          }}
                          aria-label={`View resident 360 for ${ref.residentName}`}
                          className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span>Resident</span>
                          <ChevronRight className="size-3" aria-hidden />
                        </motion.button>''',
    '''                        <div className="flex shrink-0 items-center gap-1.5">
                          {ref.status === "COMPLETED" && (
                            <motion.button
                              type="button"
                              whileTap={{ scale: 0.94 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRefundVoidTarget(ref);
                              }}
                              aria-label={`Void refund record for ${ref.residentName}`}
                              className="glass-inset hover:glass-soft flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-destructive transition-all hover:ring-1 hover:ring-destructive/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            >
                              <Trash2 className="size-3" aria-hidden />
                              <span>Void</span>
                            </motion.button>
                          )}
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigateTo(`/admin/residents/${ref.residentId}`);
                            }}
                            aria-label={`View resident 360 for ${ref.residentName}`}
                            className="glass-inset hover:glass-soft flex h-7 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            <span>Resident</span>
                            <ChevronRight className="size-3" aria-hidden />
                          </motion.button>
                        </div>''',
)
replace_once(
    "src/components/app/admin/payments.tsx",
    '''      {action && actionMeta && (
        <ConfirmDialog''',
    '''      {refundVoidTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && !refundVoidBusy && setRefundVoidTarget(null)}
          title={refundVoidTarget.mode === "ISSUE_REFUND" ? "Void issued refund" : "Void carry-forward decision"}
          description={
            refundVoidTarget.mode === "ISSUE_REFUND" ? (
              <>
                Use this only when the payout was reversed, returned, or recorded in error. BoardOps will post a compensating journal and restore
                <span className="font-semibold"> {refundVoidTarget.amountFormatted}</span> to {refundVoidTarget.residentName}&apos;s available credit.
              </>
            ) : (
              <>
                This keeps the original history but reopens this bill cycle&apos;s excess-credit decision for {refundVoidTarget.residentName}.
              </>
            )
          }
          confirmLabel="Void refund"
          tone="destructive"
          requireReason
          reasonPlaceholder="Why is this refund decision being corrected? (required)"
          loading={refundVoidBusy}
          onConfirm={(reason) => void voidRefundRecord(reason)}
        />
      )}

      {action && actionMeta && (
        <ConfirmDialog''',
)

# ---------------------------------------------------------------------------
# Resident contract/UI: only committed refund states are user-visible and
# correction provenance is visible instead of looking like a successful payout.
# ---------------------------------------------------------------------------
replace_once(
    "src/components/app/resident/_shared/types.ts",
    '''  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "VOIDED" | string;
  reason: string;
  destination: string | null;
  paymentId: string | null;
  createdAt: string;
  completedAt: string | null;''',
    '''  status: "COMPLETED" | "VOIDED" | string;
  reason: string;
  destination: string | null;
  paymentId: string | null;
  reversalJournalId: string | null;
  voidReason: string | null;
  voidedByUserId: string | null;
  voidedAt: string | null;
  createdAt: string;
  completedAt: string | null;''',
)
replace_once(
    "src/components/app/resident/payments.tsx",
    '''                                  {r.mode === "CARRY_FORWARD" ? "Carried Forward" : "Refund Issued"}''',
    '''                                  {r.status === "VOIDED"
                                    ? r.mode === "CARRY_FORWARD"
                                      ? "Carry Forward Corrected"
                                      : "Refund Corrected"
                                    : r.mode === "CARRY_FORWARD"
                                      ? "Carried Forward"
                                      : "Refund Issued"}''',
)
replace_once(
    "src/components/app/resident/payments.tsx",
    '''                                {r.mode === "CARRY_FORWARD" ? "credited" : "refunded"}''',
    '''                                {r.status === "VOIDED" ? "corrected" : r.mode === "CARRY_FORWARD" ? "credited" : "refunded"}''',
)
replace_once(
    "src/components/app/resident/payments.tsx",
    '''                              <span className="text-[11px] text-muted-foreground truncate max-w-[180px]" title={r.reason}>
                                {r.reason}
                              </span>''',
    '''                              <span className="text-[11px] text-muted-foreground truncate max-w-[180px]" title={r.status === "VOIDED" ? r.voidReason ?? r.reason : r.reason}>
                                {r.status === "VOIDED" ? `Corrected: ${r.voidReason ?? "Administrative correction"}` : r.reason}
                              </span>''',
)

# ---------------------------------------------------------------------------
# Resident 360 contract: correction provenance survives every finance read model.
# ---------------------------------------------------------------------------
replace_once(
    "src/app/api/v1/admin/residents/[id]/route.ts",
    '''        destination: r.destination,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,''',
    '''        destination: r.destination,
        reversalJournalId: r.reversalJournalId,
        voidReason: r.voidReason,
        voidedByUserId: r.voidedByUserId,
        voidedAt: r.voidedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,''',
)
replace_once(
    "src/components/app/admin/_shared/types.ts",
    '''    reason: string;
    destination: string | null;
    createdAt: string;
    completedAt: string | null;''',
    '''    reason: string;
    destination: string | null;
    reversalJournalId: string | null;
    voidReason: string | null;
    voidedByUserId: string | null;
    voidedAt: string | null;
    createdAt: string;
    completedAt: string | null;''',
)
replace_once(
    "src/components/app/admin/resident360.tsx",
    '''                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {ref.reason}
                        </p>''',
    '''                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {ref.status === "VOIDED" ? `Corrected: ${ref.voidReason ?? "Administrative correction"}` : ref.reason}
                        </p>''',
)

# Route should follow the same dynamic API convention as the other finance writes.
replace_once(
    "src/app/api/v1/admin/refunds/[id]/void/route.ts",
    '''import { sweepOutbox } from "@/lib/outbox";

const bodySchema''',
    '''import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

const bodySchema''',
)

print("Phase 45 guarded patch applied successfully")
