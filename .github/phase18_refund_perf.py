from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# Payments meta can cheaply tell the UI whether Refund Center is relevant.
path = "src/app/api/v1/admin/payments/route.ts"
replace_once(
    path,
    '  const [receivedAgg, pendingCount, refundsAgg] = await Promise.all([',
    '  const [receivedAgg, pendingCount, refundsAgg, generatedBillCount] = await Promise.all([',
)
replace_once(
    path,
    '''    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        status: "COMPLETED",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
  ]);
''',
    '''    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        institutionId: ctx.institutionId,
        status: "COMPLETED",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.bill.count({
      where: { institutionId: ctx.institutionId, status: { not: "VOIDED" } },
    }),
  ]);
''',
)
replace_once(
    path,
    '''      refundsThisMonth: refundsAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(refundsAgg._sum.amountMinor ?? 0),
''',
    '''      refundsThisMonth: refundsAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(refundsAgg._sum.amountMinor ?? 0),
      hasGeneratedBills: generatedBillCount > 0,
''',
)

# The expensive per-resident eligibility queue is only needed when its screen is open.
path = "src/components/app/admin/payments.tsx"
replace_once(
    path,
    '''  const refundCandidatesQuery = useApiMetaQuery<RefundCandidate[]>(
    "/api/v1/admin/refunds/eligible",
    { q: status === "REFUND_CENTER" ? appliedSearch || undefined : undefined },
    { staleTime: 5_000 }
  );
''',
    '''  const refundCandidatesQuery = useApiMetaQuery<RefundCandidate[]>(
    "/api/v1/admin/refunds/eligible",
    { q: status === "REFUND_CENTER" ? appliedSearch || undefined : undefined },
    { enabled: status === "REFUND_CENTER", staleTime: 5_000 }
  );
''',
)
replace_once(
    path,
    '''  const refundCandidateCount = metaNum(refundCandidateMeta, "candidateCount") ?? refundCandidates.length;
  const hasGeneratedBills = refundCandidateMeta.hasGeneratedBills === true;
''',
    '''  const refundCandidateCount = metaNum(refundCandidateMeta, "candidateCount") ?? refundCandidates.length;
  const hasGeneratedBills = meta.hasGeneratedBills === true;
''',
)

print("Phase 18 Refund Center lazy-loading patch applied")
