from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src/lib/domain/funds.ts"
text = p.read_text()
old = ''' * Recompute the resident's ENTIRE bill settlement from first principles:
 * pool = Σ APPROVED payments (voided/pending excluded), allocated FIFO to the
 * resident's live bills (oldest due first, each capped at subtotal+adjustments).
 * Excess pool stays unapplied (= the resident's available credit).
 *
 * Why a full recompute instead of incremental apply/un-apply: a payment's
 * exact attribution to bills isn't stored, and approve/void/refund can each
 * change the pool — recomputing is idempotent, race-safe to re-run, and can
 * never drift (no per-event arithmetic to get wrong).'''
new = ''' * Recompute the resident's ENTIRE bill settlement from first principles:
 * pool = Σ APPROVED payments − Σ COMPLETED ISSUE_REFUND cash payouts,
 * allocated FIFO to live bills (oldest due first, each capped at
 * subtotal+adjustments). Pending/voided payments and voided refunds are excluded;
 * carry-forward never removes cash and therefore does not reduce this pool.
 * Excess pool stays unapplied (= the resident's available credit).
 *
 * Why a full recompute instead of incremental apply/un-apply: exact payment
 * attribution isn't stored, and approve/void/refund/refund-correction can each
 * change spendable resident funds. Recomputing is idempotent, race-safe to
 * re-run, and cannot drift through per-event arithmetic.'''
if text.count(old) != 1:
    raise SystemExit(f"comment assertion failed: {text.count(old)}")
text = text.replace(old, new, 1)
old2 = '''  const poolAgg = await client.payment.aggregate({
    where: { residentId, status: "APPROVED" },
    _sum: { amountMinor: true },
  });
  const poolMinor = poolAgg._sum.amountMinor ?? 0;

  const bills = await client.bill.findMany({'''
new2 = '''  const [approvedAgg, completedCashRefundAgg] = await Promise.all([
    client.payment.aggregate({
      where: { residentId, status: "APPROVED" },
      _sum: { amountMinor: true },
    }),
    client.refund.aggregate({
      where: { residentId, status: "COMPLETED", mode: "ISSUE_REFUND" },
      _sum: { amountMinor: true },
    }),
  ]);
  const approvedMinor = approvedAgg._sum.amountMinor ?? 0;
  const completedCashRefundMinor = completedCashRefundAgg._sum.amountMinor ?? 0;
  const poolMinor = Math.max(0, approvedMinor - completedCashRefundMinor);

  const bills = await client.bill.findMany({'''
if text.count(old2) != 1:
    raise SystemExit(f"pool assertion failed: {text.count(old2)}")
p.write_text(text.replace(old2, new2, 1))
print("refund-aware FIFO settlement patch applied")
