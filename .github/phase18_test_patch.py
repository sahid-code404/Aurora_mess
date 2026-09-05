from pathlib import Path

p = Path("tests/integration/financial-core.test.ts")
text = p.read_text()
old = '''    await db.payment.create({
      data: {
        institutionId: institution.id,
        displayNumber: unique("PAY-CONCURRENT"),
        residentId: resident.id,
        amountMinor: 10000,
        method: "UPI",
        status: "APPROVED",
      },
    });

    // Avoid chart-of-accounts creation itself being the contested write; this
    // test isolates the resident-credit serialization boundary.
'''
new = '''    await db.payment.create({
      data: {
        institutionId: institution.id,
        displayNumber: unique("PAY-CONCURRENT"),
        residentId: resident.id,
        amountMinor: 10000,
        method: "UPI",
        status: "APPROVED",
      },
    });

    // Refunds are a post-billing lifecycle action. The ₹100 bill consumes part
    // of the approved ₹100 credit, leaving exactly ₹90 of refundable excess.
    await createBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 12,
      subtotalMinor: 1000,
      dueDate: new Date(Date.now() + 10 * 86_400_000),
    });
    await recomputeBillSettlement(db, resident.id);

    // Avoid chart-of-accounts creation itself being the contested write; this
    // test isolates the resident-credit serialization boundary.
'''
if text.count(old) != 1:
    raise SystemExit(f"financial-core concurrent fixture anchor count={text.count(old)}")
text = text.replace(old, new, 1)
old2 = '''    const after = await residentFundsSummary(resident.id);
    expect(after.creditsMinor).toBe(10000);
    expect(after.refundsIssuedMinor).toBe(6000);
    expect(after.availableMinor).toBe(4000);
'''
new2 = '''    const after = await residentFundsSummary(resident.id);
    expect(after.creditsMinor).toBe(10000);
    expect(after.chargesMinor).toBe(1000);
    expect(after.refundsIssuedMinor).toBe(6000);
    expect(after.availableMinor).toBe(3000);
'''
if text.count(old2) != 1:
    raise SystemExit(f"financial-core concurrent expectations anchor count={text.count(old2)}")
p.write_text(text.replace(old2, new2, 1))
print("Phase 18 existing refund regression updated")
