from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/app/api/v1/admin/dashboard/route.ts",
    '    db.taskSubmission.count({ where: { status: "SUBMITTED" } }),',
    '    db.taskSubmission.count({\n      where: { status: "SUBMITTED", task: { institutionId: ctx.institutionId } },\n    }),',
)

replace_once(
    "src/components/app/resident/payments.tsx",
    '''              value={
                meta?.refundsThisMonthFormatted && meta.refundsThisMonthFormatted !== "₹0.00"
                  ? meta.refundsThisMonthFormatted
                  : meta?.refundPendingCount
                    ? `${meta.refundPendingCount} Pending`
                    : "—"
              }
              sub={meta?.refundPendingCount ? "In review" : "Processed"}''',
    '''              value={
                meta?.refundPendingCount
                  ? `${meta.refundPendingCount} Pending`
                  : meta?.refundsThisMonthFormatted ?? "₹0.00"
              }
              sub={meta?.refundPendingCount ? "In review" : (meta?.refundsThisMonth ?? 0) > 0 ? "Processed" : "No refunds"}''',
)

p = "src/components/app/admin/payments.tsx"
replace_once(p, 'import { motion } from "framer-motion";', 'import { AnimatePresence, motion } from "framer-motion";')
replace_once(
    p,
    'import { fmtDateTime, monthLabel, todayKey } from "./_shared/format";\n',
    'import { fmtDateTime, monthLabel, todayKey } from "./_shared/format";\nimport { RefundDialog } from "./_shared/refund-dialog";\n',
)
replace_once(
    p,
    '''interface RefundRow {
  id: string;
  residentId: string;
  residentName: string;
  amountMinor: number;
  amountFormatted: string;
  mode: "ISSUE_REFUND" | "CARRY_FORWARD";
  reason: string;
  destination: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
}
''',
    '''interface RefundRow {
  id: string;
  residentId: string;
  residentName: string;
  amountMinor: number;
  amountFormatted: string;
  mode: "ISSUE_REFUND" | "CARRY_FORWARD";
  reason: string;
  destination: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

interface RefundCandidate {
  residentId: string;
  residentName: string;
  roomNumber: string | null;
  email: string;
  refundableMinor: number;
  refundableFormatted: string;
  creditsMinor: number;
  creditsFormatted: string;
  chargesMinor: number;
  chargesFormatted: string;
  refundsIssuedMinor: number;
  refundsIssuedFormatted: string;
  latestBill: {
    id: string;
    billNumber: string;
    billingPeriodId: string;
    year: number;
    month: number;
    generatedAt: string;
  };
}
''',
)
replace_once(
    p,
    '  const [action, setAction] = useState<ReviewAction | null>(null);\n  const [acting, setActing] = useState(false);',
    '  const [action, setAction] = useState<ReviewAction | null>(null);\n  const [refundTarget, setRefundTarget] = useState<RefundCandidate | null>(null);\n  const [acting, setActing] = useState(false);',
)
replace_once(
    p,
    '''  const { data, isLoading, error, refetch } = useApiMetaQuery<PaymentRow[]>(PAYMENTS_PATH, {
    status: status === "ALL" || status === "REFUNDS" ? undefined : status,
    q: appliedSearch || undefined,
    month: monthParam,
  });

  const refundsQuery = useApiMetaQuery<RefundRow[]>("/api/v1/admin/refunds", undefined, {
    enabled: status === "REFUNDS",
  });
''',
    '''  const { data, isLoading, error, refetch } = useApiMetaQuery<PaymentRow[]>(PAYMENTS_PATH, {
    status: status === "ALL" || status === "REFUNDS" || status === "REFUND_CENTER" ? undefined : status,
    q: status === "REFUND_CENTER" ? undefined : appliedSearch || undefined,
    month: monthParam,
  });

  const refundsQuery = useApiMetaQuery<RefundRow[]>("/api/v1/admin/refunds", undefined, {
    enabled: status === "REFUNDS",
  });
  const refundCandidatesQuery = useApiMetaQuery<RefundCandidate[]>(
    "/api/v1/admin/refunds/eligible",
    { q: status === "REFUND_CENTER" ? appliedSearch || undefined : undefined },
    { staleTime: 5_000 }
  );
''',
)
replace_once(
    p,
    '  const payments = data?.data ?? [];\n  const meta = data?.meta ?? {};\n',
    '''  const payments = data?.data ?? [];
  const meta = data?.meta ?? {};
  const refundCandidates = refundCandidatesQuery.data?.data ?? [];
  const refundCandidateMeta = refundCandidatesQuery.data?.meta ?? {};
  const refundCandidateCount = metaNum(refundCandidateMeta, "candidateCount") ?? refundCandidates.length;
  const hasGeneratedBills = refundCandidateMeta.hasGeneratedBills === true;
''',
)
replace_once(
    p,
    '      invalidate([PAYMENTS_PATH, detailPath, "/api/v1/admin/funds", "/api/v1/admin/dashboard"]);',
    '      invalidate([PAYMENTS_PATH, detailPath, "/api/v1/admin/funds", "/api/v1/admin/dashboard", "/api/v1/admin/refunds/eligible"]);',
)
replace_once(p, '            value: metaStr(meta, "receivedThisMonthFormatted") ?? "—",', '            value: metaStr(meta, "receivedThisMonthFormatted") ?? "₹0.00",')
replace_once(p, '            value: metaStr(meta, "refundsThisMonthFormatted") ?? "—",', '            value: metaStr(meta, "refundsThisMonthFormatted") ?? "₹0.00",')
replace_once(
    p,
    '''      </KpiGrid>
      </StaggerItem>

      {/* ONE section card''',
    '''      </KpiGrid>
      </StaggerItem>

      {hasGeneratedBills && (
        <StaggerItem>
          <div className="flex justify-center">
            <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}>
              <GlassButton variant="primary" icon={<RotateCcw />} onClick={() => setStatus("REFUND_CENTER")}>
                Refund Center{refundCandidateCount > 0 ? ` · ${refundCandidateCount}` : ""}
              </GlassButton>
            </motion.div>
          </div>
        </StaggerItem>
      )}

      {/* ONE section card''',
)
replace_once(
    p,
    '''        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Wallet className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">Payments</h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search by number, name or reference…" />''',
    '''        <div className="mb-3 flex items-center gap-2">
          <motion.span
            key={status === "REFUND_CENTER" || status === "REFUNDS" ? "refund" : "payment"}
            initial={{ scale: 0.8, opacity: 0, rotate: -8 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"
          >
            {status === "REFUND_CENTER" || status === "REFUNDS" ? <RotateCcw className="size-5" aria-hidden /> : <Wallet className="size-5" aria-hidden />}
          </motion.span>
          <h3 className="font-semibold text-base">
            {status === "REFUND_CENTER" ? "Refund Center" : status === "REFUNDS" ? "Refund history" : "Payments"}
          </h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={status === "REFUND_CENTER" ? "Search overpaid residents…" : status === "REFUNDS" ? "Search refund history…" : "Search by number, name or reference…"}
          />''',
)
replace_once(
    p,
    '        {status === "REFUNDS" ? (\n',
    '''        <AnimatePresence mode="wait" initial={false}>
        {status === "REFUND_CENTER" ? (
          <motion.div key="refund-center" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
            {refundCandidatesQuery.isLoading && !refundCandidatesQuery.data ? (
              <ListSkeleton rows={4} />
            ) : refundCandidatesQuery.error ? (
              <ErrorState code={(refundCandidatesQuery.error as ApiClientError).code} message={(refundCandidatesQuery.error as ApiClientError).message} onRetry={() => void refundCandidatesQuery.refetch()} />
            ) : refundCandidates.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="No overpayments to resolve"
                description="After billing, residents with excess approved credit appear here. Carry-forward decisions stay resolved until a newer bill is generated."
              />
            ) : (
              <div className="no-scrollbar max-h-[30rem] space-y-2 overflow-y-auto pr-1">
                {refundCandidates.map((candidate, i) => (
                  <motion.div key={candidate.residentId} initial={{ opacity: 0, y: 8, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.22 }}>
                    <GlassCard className="overflow-hidden rounded-2xl">
                      <div className="p-3 sm:p-3.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <MealOrb icon={<RotateCcw />} colorToken="emerald" size="sm" />
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-semibold text-foreground">{candidate.residentName}</h4>
                              <p className="truncate text-xs text-muted-foreground">{candidate.roomNumber ? `Room ${candidate.roomNumber} · ` : ""}{candidate.latestBill.billNumber}</p>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <Money minor={candidate.refundableMinor} className="block text-base font-bold text-success sm:text-lg" />
                            <span className="text-[11px] font-medium text-muted-foreground">excess credit</span>
                          </div>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/15 pt-2">
                          <div className="no-scrollbar flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-muted-foreground">
                            <span className="shrink-0">Paid <Money minor={candidate.creditsMinor} plain className="font-semibold" /></span>
                            <span className="shrink-0">Billed <Money minor={candidate.chargesMinor} plain className="font-semibold" /></span>
                            {candidate.refundsIssuedMinor > 0 && <span className="shrink-0">Returned <Money minor={candidate.refundsIssuedMinor} plain className="font-semibold" /></span>}
                          </div>
                          <GlassButton size="sm" variant="primary" icon={<RotateCcw />} onClick={() => setRefundTarget(candidate)}>Resolve</GlassButton>
                        </div>
                      </div>
                    </GlassCard>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        ) : status === "REFUNDS" ? (
''',
)
replace_once(
    p,
    '''        )}
      </GlassCard>
      </StaggerItem>

      {/* ------------------------------ review dialog ------------------------------ */}''',
    '''        )}
        </AnimatePresence>
      </GlassCard>
      </StaggerItem>

      {refundTarget && (
        <RefundDialog
          open
          onOpenChange={(open) => !open && setRefundTarget(null)}
          residentId={refundTarget.residentId}
          residentName={refundTarget.residentName}
          availableMinor={refundTarget.refundableMinor}
          latestBillNumber={refundTarget.latestBill.billNumber}
          billingPeriodLabel={monthShortLabel(`${refundTarget.latestBill.year}-${String(refundTarget.latestBill.month).padStart(2, "0")}`)}
          onSaved={() => {
            invalidate(["/api/v1/admin/refunds/eligible", "/api/v1/admin/refunds", PAYMENTS_PATH, "/api/v1/admin/funds", "/api/v1/admin/dashboard", "/api/v1/admin/billing"]);
            setRefundTarget(null);
          }}
        />
      )}

      {/* ------------------------------ review dialog ------------------------------ */}''',
)

print("Phase 18 UI patch applied")
