from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"pattern missing in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# Admin Payments: Refund KPI is cash payout only; carry-forward is separate metadata.
replace_once(
    "src/app/api/v1/admin/payments/route.ts",
    "const [receivedAgg, pendingCount, refundsAgg, generatedBillCount] = await Promise.all([",
    "const [receivedAgg, pendingCount, refundsAgg, carryForwardAgg, generatedBillCount] = await Promise.all([",
)
replace_once(
    "src/app/api/v1/admin/payments/route.ts",
    '''    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.bill.count({''',
    '''    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        mode: "ISSUE_REFUND",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        mode: "CARRY_FORWARD",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.bill.count({''',
)
replace_once(
    "src/app/api/v1/admin/payments/route.ts",
    '''      refundsThisMonth: refundsAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(refundsAgg._sum.amountMinor ?? 0),\n      hasGeneratedBills: generatedBillCount > 0,''',
    '''      // Refund KPIs are cash outflow only. Carry-forward is retained resident credit.\n      refundsThisMonth: refundsAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(refundsAgg._sum.amountMinor ?? 0),\n      carriedForwardThisMonth: carryForwardAgg._sum.amountMinor ?? 0,\n      carriedForwardThisMonthFormatted: formatMinor(carryForwardAgg._sum.amountMinor ?? 0),\n      hasGeneratedBills: generatedBillCount > 0,''',
)

# Resident Payments summary uses the same semantics.
replace_once(
    "src/app/api/v1/payments/route.ts",
    "const [depositsAgg, pendingCount, refundPendingCount, refundsThisMonthAgg, funds] = await Promise.all([",
    "const [depositsAgg, pendingCount, refundPendingCount, refundsThisMonthAgg, carryForwardThisMonthAgg, funds] = await Promise.all([",
)
replace_once(
    "src/app/api/v1/payments/route.ts",
    '''    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        residentId: ctx.user.id,\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    residentFundsSummary(ctx.user.id),''',
    '''    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        residentId: ctx.user.id,\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        mode: "ISSUE_REFUND",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        residentId: ctx.user.id,\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        mode: "CARRY_FORWARD",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    residentFundsSummary(ctx.user.id),''',
)
replace_once(
    "src/app/api/v1/payments/route.ts",
    '''      refundsThisMonth: refundsThisMonthAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(refundsThisMonthAgg._sum.amountMinor ?? 0),''',
    '''      refundsThisMonth: refundsThisMonthAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(refundsThisMonthAgg._sum.amountMinor ?? 0),\n      carriedForwardThisMonth: carryForwardThisMonthAgg._sum.amountMinor ?? 0,\n      carriedForwardThisMonthFormatted: formatMinor(carryForwardThisMonthAgg._sum.amountMinor ?? 0),''',
)

# Resident refund-history metadata separates cash returned from retained credit.
replace_once(
    "src/app/api/v1/refunds/route.ts",
    '''  const [thisMonthAgg, totalAgg] = await Promise.all([\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        residentId: ctx.user.id,\n        status: "COMPLETED",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        residentId: ctx.user.id,\n        status: "COMPLETED",\n      },\n    }),\n  ]);''',
    '''  const [cashThisMonthAgg, cashTotalAgg, carryThisMonthAgg, carryTotalAgg] = await Promise.all([\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        residentId: ctx.user.id,\n        status: "COMPLETED",\n        mode: "ISSUE_REFUND",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        residentId: ctx.user.id,\n        status: "COMPLETED",\n        mode: "ISSUE_REFUND",\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        residentId: ctx.user.id,\n        status: "COMPLETED",\n        mode: "CARRY_FORWARD",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        residentId: ctx.user.id,\n        status: "COMPLETED",\n        mode: "CARRY_FORWARD",\n      },\n    }),\n  ]);''',
)
replace_once(
    "src/app/api/v1/refunds/route.ts",
    '''      refundsThisMonth: thisMonthAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(thisMonthAgg._sum.amountMinor ?? 0),\n      totalRefunded: totalAgg._sum.amountMinor ?? 0,\n      totalRefundedFormatted: formatMinor(totalAgg._sum.amountMinor ?? 0),''',
    '''      refundsThisMonth: cashThisMonthAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(cashThisMonthAgg._sum.amountMinor ?? 0),\n      totalRefunded: cashTotalAgg._sum.amountMinor ?? 0,\n      totalRefundedFormatted: formatMinor(cashTotalAgg._sum.amountMinor ?? 0),\n      carriedForwardThisMonth: carryThisMonthAgg._sum.amountMinor ?? 0,\n      carriedForwardThisMonthFormatted: formatMinor(carryThisMonthAgg._sum.amountMinor ?? 0),\n      totalCarriedForward: carryTotalAgg._sum.amountMinor ?? 0,\n      totalCarriedForwardFormatted: formatMinor(carryTotalAgg._sum.amountMinor ?? 0),''',
)

# Admin refund-history metadata likewise separates cash and carry-forward.
replace_once(
    "src/app/api/v1/admin/refunds/route.ts",
    '''  const thisMonthAgg = await db.refund.aggregate({\n    _sum: { amountMinor: true },\n    where: {\n      institutionId: ctx.institutionId,\n      status: "COMPLETED",\n      createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n    },\n  });''',
    '''  const [cashThisMonthAgg, carryThisMonthAgg] = await Promise.all([\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        mode: "ISSUE_REFUND",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n    db.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: {\n        institutionId: ctx.institutionId,\n        status: "COMPLETED",\n        mode: "CARRY_FORWARD",\n        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },\n      },\n    }),\n  ]);''',
)
replace_once(
    "src/app/api/v1/admin/refunds/route.ts",
    '''      refundsThisMonth: thisMonthAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(thisMonthAgg._sum.amountMinor ?? 0),''',
    '''      refundsThisMonth: cashThisMonthAgg._sum.amountMinor ?? 0,\n      refundsThisMonthFormatted: formatMinor(cashThisMonthAgg._sum.amountMinor ?? 0),\n      carriedForwardThisMonth: carryThisMonthAgg._sum.amountMinor ?? 0,\n      carriedForwardThisMonthFormatted: formatMinor(carryThisMonthAgg._sum.amountMinor ?? 0),''',
)

# Formula payment variables: cash refund is cash outflow; carry-forward is explicit retained credit.
replace_once(
    "src/lib/domain/formula/providers/payment.ts",
    "const [submittedAgg, approvedAgg, pendingAgg, depositsAgg, refundsAgg, creditsAgg] = await Promise.all([",
    "const [submittedAgg, approvedAgg, pendingAgg, depositsAgg, refundsAgg, carryForwardAgg, creditsAgg] = await Promise.all([",
)
replace_once(
    "src/lib/domain/formula/providers/payment.ts",
    '''    client.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: { institutionId, status: "COMPLETED", createdAt: timeRange },\n    }),\n    client.ledgerEntry.aggregate({''',
    '''    client.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: { institutionId, status: "COMPLETED", mode: "ISSUE_REFUND", createdAt: timeRange },\n    }),\n    client.refund.aggregate({\n      _sum: { amountMinor: true },\n      where: { institutionId, status: "COMPLETED", mode: "CARRY_FORWARD", createdAt: timeRange },\n    }),\n    client.ledgerEntry.aggregate({''',
)
replace_once(
    "src/lib/domain/formula/providers/payment.ts",
    '''    total_refunds: refundsAgg._sum.amountMinor ?? 0,\n    total_credits: creditsAgg._sum.creditMinor ?? 0,''',
    '''    total_refunds: refundsAgg._sum.amountMinor ?? 0,\n    total_carry_forward: carryForwardAgg._sum.amountMinor ?? 0,\n    total_credits: creditsAgg._sum.creditMinor ?? 0,''',
)
replace_once(
    "src/lib/domain/formula/variables.ts",
    '''  {\n    key: "total_refunds",\n    displayName: "Total Refunds",\n    description: "Approved refunds paid out during the period.",\n    category: "SYSTEM",\n    valueType: "MONEY",\n    unit: "INR",\n    scope: "BILLING_PERIOD",\n    providerKey: "PAYMENT_ENGINE",\n  },\n  {\n    key: "total_credits",''',
    '''  {\n    key: "total_refunds",\n    displayName: "Total Refunds",\n    description: "Cash refunds actually paid out to residents during the period. Carry-forward credit is excluded.",\n    category: "SYSTEM",\n    valueType: "MONEY",\n    unit: "INR",\n    scope: "BILLING_PERIOD",\n    providerKey: "PAYMENT_ENGINE",\n  },\n  {\n    key: "total_carry_forward",\n    displayName: "Total Carry Forward",\n    description: "Resident excess credit explicitly retained for future bills during the period; this is not a cash refund.",\n    category: "SYSTEM",\n    valueType: "MONEY",\n    unit: "INR",\n    scope: "BILLING_PERIOD",\n    providerKey: "PAYMENT_ENGINE",\n  },\n  {\n    key: "total_credits",''',
)

# UI labels make the cash-only KPI meaning explicit without adding another card.
replace_once(
    "src/components/app/admin/payments.tsx",
    '''            label: "Refunds",\n            value: metaStr(meta, "refundsThisMonthFormatted") ?? "₹0.00",\n            icon: <RotateCcw />,\n            sub: "Processed",''',
    '''            label: "Refunds",\n            value: metaStr(meta, "refundsThisMonthFormatted") ?? "₹0.00",\n            icon: <RotateCcw />,\n            sub: "Cash paid",''',
)
replace_once(
    "src/components/app/resident/payments.tsx",
    'sub={meta?.refundPendingCount ? "In review" : (meta?.refundsThisMonth ?? 0) > 0 ? "Processed" : "No refunds"}',
    'sub={meta?.refundPendingCount ? "In review" : (meta?.refundsThisMonth ?? 0) > 0 ? "Cash returned" : "No cash refunds"}',
)
replace_once(
    "src/components/app/resident/_shared/types.ts",
    '''  refundsThisMonth?: number;\n  refundsThisMonthFormatted?: string;\n}''',
    '''  refundsThisMonth?: number;\n  refundsThisMonthFormatted?: string;\n  carriedForwardThisMonth?: number;\n  carriedForwardThisMonthFormatted?: string;\n}''',
)

# Extend the already-real Refund Center HTTP gate to prove KPI semantics.
replace_once(
    "tests/seeded-refund-center-smoke.py",
    '''    available_before = payments_before.meta.get("totalAvailableMinor")\n    deposits_before = payments_before.meta.get("totalDepositsAllTime")\n    check(isinstance(available_before, int), "resident available-balance baseline missing")\n    check(isinstance(deposits_before, int), "resident deposit baseline missing")''',
    '''    available_before = payments_before.meta.get("totalAvailableMinor")\n    deposits_before = payments_before.meta.get("totalDepositsAllTime")\n    cash_refunds_before = int(payments_before.meta.get("refundsThisMonth") or 0)\n    carry_forward_before = int(payments_before.meta.get("carriedForwardThisMonth") or 0)\n    check(isinstance(available_before, int), "resident available-balance baseline missing")\n    check(isinstance(deposits_before, int), "resident deposit baseline missing")''',
)
replace_once(
    "tests/seeded-refund-center-smoke.py",
    '''    check(any(row.get("id") == payout_id for row in resident_history), "Resident refund history omitted cash payout")\n    check(any(row.get("id") == carry_id for row in resident_history), "Resident refund history omitted carry-forward")\n\n    print(''',
    '''    check(any(row.get("id") == payout_id for row in resident_history), "Resident refund history omitted cash payout")\n    check(any(row.get("id") == carry_id for row in resident_history), "Resident refund history omitted carry-forward")\n\n    resident_payment_metrics = resident.get("/api/v1/payments?limit=100").meta\n    admin_payment_metrics = admin.get("/api/v1/admin/payments?limit=100").meta\n    resident_refund_metrics = resident.get("/api/v1/refunds?limit=100").meta\n    admin_refund_metrics = admin.get(f"/api/v1/admin/refunds?residentId={resident_id}&limit=100").meta\n    for label, metrics in [\n        ("resident payments", resident_payment_metrics),\n        ("admin payments", admin_payment_metrics),\n        ("resident refunds", resident_refund_metrics),\n        ("admin refunds", admin_refund_metrics),\n    ]:\n        check(\n            int(metrics.get("refundsThisMonth") or 0) >= cash_refunds_before + partial,\n            f"{label} cash-refund KPI did not include the payout",\n        )\n        check(\n            int(metrics.get("carriedForwardThisMonth") or 0) >= carry_forward_before + remainder,\n            f"{label} carry-forward KPI did not expose retained credit separately",\n        )\n\n    print(''',
)

print("Phase 22 refund metric patch applied")
