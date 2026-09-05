from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

p = "src/lib/domain/billing.ts"

# Residents who consumed services while members must still be billed if they
# were deactivated after the period. Current account status must not erase
# historical consumption.
old = '      where: { institutionId: period.institutionId, role: "RESIDENT", status: "ACTIVE" },'
new = '      where: { institutionId: period.institutionId, role: "RESIDENT", status: { in: ["ACTIVE", "INACTIVE", "PENDING_DELETION"] } },'
text = Path(p).read_text()
count = text.count(old)
if count != 2:
    raise SystemExit(f"{p}: expected 2 billable resident status queries, found {count}")
Path(p).write_text(text.replace(old, new))

# Gather historical approved account credit and prior charges once, before
# creating the new bills. This is the source for carry-forward/prepayment
# application at bill generation.
replace_once(
    p,
    '''    const paymentsByResident = new Map<string, any[]>();
    for (const p of paymentRows as any[]) {
      const list = paymentsByResident.get(p.residentId) ?? [];
      list.push(p);
      paymentsByResident.set(p.residentId, list);
    }

    // ---- Immutable snapshot ----''',
    '''    const paymentsByResident = new Map<string, any[]>();
    for (const p of paymentRows as any[]) {
      const list = paymentsByResident.get(p.residentId) ?? [];
      list.push(p);
      paymentsByResident.set(p.residentId, list);
    }

    // Account credit is not scoped to the billed month. A resident may have
    // prepaid earlier or explicitly carried forward excess from the previous
    // bill. New bills must consume that existing approved credit immediately,
    // otherwise the bill can incorrectly show Due while Funds shows a positive
    // balance. Read all three authoritative components in one bounded batch.
    const [allApprovedCreditRows, priorBillRows, completedCashRefundRows] = await Promise.all([
      tx.payment.findMany({
        where: {
          institutionId: period.institutionId,
          status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },
        },
        select: { id: true, residentId: true, amountMinor: true },
      }),
      tx.bill.findMany({
        where: { institutionId: period.institutionId, status: { not: "VOIDED" } },
        select: { residentId: true, subtotalMinor: true, adjustmentsMinor: true },
      }),
      tx.refund.findMany({
        where: {
          institutionId: period.institutionId,
          status: "COMPLETED",
          mode: "ISSUE_REFUND",
        },
        select: { residentId: true, amountMinor: true },
      }),
    ]);

    const approvedCreditByResident = new Map<string, number>();
    for (const row of allApprovedCreditRows as any[]) {
      approvedCreditByResident.set(
        row.residentId,
        (approvedCreditByResident.get(row.residentId) ?? 0) + row.amountMinor
      );
    }
    const priorChargesByResident = new Map<string, number>();
    for (const row of priorBillRows as any[]) {
      const effectiveCharge = Math.max(0, row.subtotalMinor + row.adjustmentsMinor);
      priorChargesByResident.set(
        row.residentId,
        (priorChargesByResident.get(row.residentId) ?? 0) + effectiveCharge
      );
    }
    const cashRefundsByResident = new Map<string, number>();
    for (const row of completedCashRefundRows as any[]) {
      cashRefundsByResident.set(
        row.residentId,
        (cashRefundsByResident.get(row.residentId) ?? 0) + row.amountMinor
      );
    }
    const accountCreditBeforeBillByResident = new Map<string, number>();
    for (const resident of residents) {
      const approved = approvedCreditByResident.get(resident.id) ?? 0;
      const priorCharges = priorChargesByResident.get(resident.id) ?? 0;
      const cashRefunds = cashRefundsByResident.get(resident.id) ?? 0;
      accountCreditBeforeBillByResident.set(
        resident.id,
        Math.max(0, approved - priorCharges - cashRefunds)
      );
    }

    // ---- Immutable snapshot ----''',
)

replace_once(
    p,
    '''          guestAmountMinor: guest.amountMinor,
          approvedPaymentsMinor: (paymentsByResident.get(r.id) ?? []).reduce((s, p) => s + p.amountMinor, 0),
        };''',
    '''          guestAmountMinor: guest.amountMinor,
          approvedPaymentsMinor: (paymentsByResident.get(r.id) ?? []).reduce((s, p) => s + p.amountMinor, 0),
          accountCreditBeforeBillMinor: accountCreditBeforeBillByResident.get(r.id) ?? 0,
        };''',
)

replace_once(
    p,
    '''      const subtotal = mealAmount + guestAmount;
      const myPayments = paymentsByResident.get(resident.id) ?? [];
      const myApprovedTotal = myPayments.reduce((s, p) => s + p.amountMinor, 0);
      const paymentsApplied = Math.min(subtotal, myApprovedTotal);
      const totalDue = Math.max(0, subtotal - paymentsApplied);''',
    '''      const subtotal = mealAmount + guestAmount;
      const myPayments = paymentsByResident.get(resident.id) ?? [];
      const periodApprovedTotal = myPayments.reduce((s, p) => s + p.amountMinor, 0);
      const accountCreditBeforeBill = accountCreditBeforeBillByResident.get(resident.id) ?? 0;
      const paymentsApplied = Math.min(subtotal, accountCreditBeforeBill);
      const totalDue = Math.max(0, subtotal - paymentsApplied);''',
)

replace_once(
    p,
    '''          detailJson: JSON.stringify({
            policy: "Payments approved with submittedAt inside the period, capped at the subtotal.",
            paymentCount: myPayments.length,
            paymentIds: myPayments.slice(0, 50).map((p) => p.id),
            approvedPaymentsMinor: myApprovedTotal,
          }),''',
    '''          detailJson: JSON.stringify({
            policy:
              "All approved resident account credit available at bill generation, after prior non-voided charges and completed cash refunds, capped at the subtotal.",
            accountCreditBeforeBillMinor: accountCreditBeforeBill,
            periodApprovedPaymentsMinor: periodApprovedTotal,
            periodPaymentCount: myPayments.length,
            periodPaymentIds: myPayments.slice(0, 50).map((p) => p.id),
          }),''',
)

print("Phase 18 billing lifecycle consistency patch applied")
