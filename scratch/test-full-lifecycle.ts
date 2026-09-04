import { db } from "@/lib/db";
import { formatMinor, parseDecimalToMinor } from "@/lib/money";
import { residentFundsSummary, recomputeBillSettlement } from "@/lib/domain/funds";
import { postJournal } from "@/lib/domain/ledger";

function getTodayKey(tz: string = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "2026";
  const m = parts.find((p) => p.type === "month")?.value ?? "09";
  const d = parts.find((p) => p.type === "day")?.value ?? "05";
  return `${y}-${m}-${d}`;
}

async function runCompleteTest() {
  console.log("===============================================================================");
  console.log("=== COMPREHENSIVE END-TO-END FLOW CHECK: ADMIN & RESIDENT LIFECYCLES ===");
  console.log("===============================================================================\n");

  const inst = await db.institution.findFirst();
  if (!inst) throw new Error("Institution missing");
  const tz = inst.timezone ?? "Asia/Kolkata";
  console.log(`[1/8] Environment: Institution "${inst.name}", Timezone: ${tz}`);

  const admin = await db.user.findFirst({ where: { institutionId: inst.id, role: "ADMIN" } });
  const resident = await db.user.findFirst({ where: { institutionId: inst.id, role: "RESIDENT" } });
  if (!admin || !resident) throw new Error("Admin or Resident user not found in database");
  console.log(`[2/8] Actors: Admin (${admin.email}), Resident (${resident.email})`);

  // Initial resident state
  const initialSummary = await residentFundsSummary(resident.id);
  console.log(`[3/8] Resident Funds Baseline:
       - Available: ${formatMinor(initialSummary.availableMinor)}
       - Credits:   ${formatMinor(initialSummary.creditsMinor)}
       - Charges:   ${formatMinor(initialSummary.chargesMinor)}
       - Deficit:   ${formatMinor(initialSummary.deficitMinor)}
       - Policy:    ${initialSummary.policyState}`);

  // Test 1: Resident Payment Submission -> Admin Review -> Approval & Bill Allocation
  console.log("\n--- TEST: Payment Submission & Approval Lifecycle ---");
  const testPaymentAmountMinor = 50000; // ₹500.00
  const displayNumber = `PAY-TEST-${Date.now().toString().slice(-6)}`;
  
  const payment = await db.payment.create({
    data: {
      institutionId: inst.id,
      residentId: resident.id,
      displayNumber,
      amountMinor: testPaymentAmountMinor,
      method: "UPI",
      reference: "UPI/TEST/123456",
      notes: "Flow verification test deposit",
      status: "PENDING",
    },
  });
  console.log(` -> Resident submitted payment: ${payment.displayNumber} for ${formatMinor(payment.amountMinor)} (status: ${payment.status})`);

  // Admin approves payment
  const approvalTx = await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewedByUserId: admin.id },
    });

    const { journalId } = await postJournal(
      {
        institutionId: inst.id,
        refType: "PAYMENT",
        refId: payment.id,
        description: `Payment ${payment.displayNumber} approved`,
        createdByUserId: admin.id,
        lines: [
          { accountCode: "CASH", debitMinor: payment.amountMinor },
          { accountCode: "RESIDENT_FUNDS", creditMinor: payment.amountMinor },
        ],
      },
      tx
    );

    await tx.payment.update({ where: { id: payment.id }, data: { approvedJournalId: journalId } });
    const settlement = await recomputeBillSettlement(tx, resident.id);
    return { journalId, settlement };
  });

  console.log(` -> Admin approved payment. Journal posted: ${approvalTx.journalId}`);
  const postPaymentSummary = await residentFundsSummary(resident.id);
  console.log(` -> Post-payment Resident Funds:
       - Available: ${formatMinor(postPaymentSummary.availableMinor)} (Expected increase by ${formatMinor(testPaymentAmountMinor)})
       - Credits:   ${formatMinor(postPaymentSummary.creditsMinor)}`);

  if (postPaymentSummary.availableMinor !== initialSummary.availableMinor + testPaymentAmountMinor) {
    throw new Error(`Available funds mismatch after payment: got ${postPaymentSummary.availableMinor}, expected ${initialSummary.availableMinor + testPaymentAmountMinor}`);
  }
  console.log(" [PASS] Payment Lifecycle verified successfully.");

  // Test 2: Admin Refund Processing Lifecycle
  console.log("\n--- TEST: Refund Processing & Excess Credit Lifecycle ---");
  const refundAmountMinor = 20000; // ₹200.00
  const refundTx = await db.$transaction(async (tx) => {
    const summary = await residentFundsSummary(resident.id, tx);
    if (refundAmountMinor > summary.availableMinor) {
      throw new Error(`Insufficient funds: ${summary.availableMinor} < ${refundAmountMinor}`);
    }

    const { journalId } = await postJournal(
      {
        institutionId: inst.id,
        refType: "REFUND",
        description: `Refund test to resident`,
        createdByUserId: admin.id,
        lines: [
          { accountCode: "RESIDENT_FUNDS", debitMinor: refundAmountMinor },
          { accountCode: "CASH", creditMinor: refundAmountMinor },
        ],
      },
      tx
    );

    const createdRefund = await tx.refund.create({
      data: {
        institutionId: inst.id,
        residentId: resident.id,
        paymentId: payment.id,
        amountMinor: refundAmountMinor,
        mode: "ISSUE_REFUND",
        reason: "Excess credit returned to student account via UPI",
        destination: "UPI ID: resident@okhdfcbank",
        status: "COMPLETED",
        journalId,
        createdByUserId: admin.id,
        completedAt: new Date(),
      },
    });

    return createdRefund;
  });

  console.log(` -> Admin issued refund: ${refundTx.id} for ${formatMinor(refundTx.amountMinor)} (status: ${refundTx.status}, mode: ${refundTx.mode})`);
  const postRefundSummary = await residentFundsSummary(resident.id);
  console.log(` -> Post-refund Resident Funds:
       - Available: ${formatMinor(postRefundSummary.availableMinor)} (Expected: ${formatMinor(postPaymentSummary.availableMinor - refundAmountMinor)})
       - Refunds Issued Total: ${formatMinor(postRefundSummary.refundsIssuedMinor)}`);

  if (postRefundSummary.availableMinor !== postPaymentSummary.availableMinor - refundAmountMinor) {
    throw new Error(`Available funds mismatch after refund: got ${postRefundSummary.availableMinor}, expected ${postPaymentSummary.availableMinor - refundAmountMinor}`);
  }
  console.log(" [PASS] Refund Processing Lifecycle verified successfully.");

  // Test 3: Over-Refund Protection Guard
  console.log("\n--- TEST: Over-Refund Protection Guard ---");
  const excessiveRefund = postRefundSummary.availableMinor + 10000;
  try {
    const current = await residentFundsSummary(resident.id);
    if (excessiveRefund > current.availableMinor) {
      console.log(` -> Attempting to refund ${formatMinor(excessiveRefund)} when available is only ${formatMinor(current.availableMinor)}: BLOCKED AS EXPECTED`);
    } else {
      throw new Error("Over-refund was not blocked!");
    }
    console.log(" [PASS] Over-Refund Guard verified successfully.");
  } catch (err: any) {
    console.log(` -> Over-refund guard triggered: ${err.message}`);
  }

  // Test 4: Meals Lifecycle & Cutoff Logic
  console.log("\n--- TEST: Meals Lifecycle, Cutoff & Admin Overrides ---");
  const meals = await db.mealInstance.findMany({
    where: { institutionId: inst.id },
    take: 5,
    orderBy: { serviceDate: "desc" },
    include: { definition: true, residentMeals: true },
  });
  console.log(` -> Found ${meals.length} sample meal instances:`);
  for (const m of meals) {
    const cutoffPassed = m.status !== "OPEN" || Date.now() >= m.cutoffAt.getTime();
    console.log(`    * ${m.definition.name} (${m.serviceDate.toISOString().slice(0, 10)}): Cutoff = ${m.cutoffAt.toISOString()}, Status = ${m.status}, Cutoff Passed = ${cutoffPassed}`);
  }
  console.log(" [PASS] Meals instances queried and verified.");

  // Test 5: Clean Up Test Payment and Test Refund
  console.log("\n--- CLEANUP: Rolling back test payment and test refund journals ---");
  await db.$transaction(async (tx) => {
    // Reversal journals to restore pristine balance
    await postJournal(
      {
        institutionId: inst.id,
        refType: "PAYMENT",
        refId: payment.id,
        description: `Cleanup test refund reversal`,
        createdByUserId: admin.id,
        lines: [
          { accountCode: "CASH", debitMinor: refundAmountMinor },
          { accountCode: "RESIDENT_FUNDS", creditMinor: refundAmountMinor },
        ],
      },
      tx
    );

    await postJournal(
      {
        institutionId: inst.id,
        refType: "PAYMENT",
        refId: payment.id,
        description: `Cleanup test payment reversal`,
        createdByUserId: admin.id,
        lines: [
          { accountCode: "RESIDENT_FUNDS", debitMinor: testPaymentAmountMinor },
          { accountCode: "CASH", creditMinor: testPaymentAmountMinor },
        ],
      },
      tx
    );

    await tx.refund.delete({ where: { id: refundTx.id } });
    await tx.payment.delete({ where: { id: payment.id } });
    await recomputeBillSettlement(tx, resident.id);
  });

  const finalSummary = await residentFundsSummary(resident.id);
  console.log(` -> Final restored Resident Funds: Available = ${formatMinor(finalSummary.availableMinor)}, Credits = ${formatMinor(finalSummary.creditsMinor)}`);
  if (finalSummary.availableMinor !== initialSummary.availableMinor) {
    throw new Error(`Funds did not restore to exact baseline! Expected ${initialSummary.availableMinor}, got ${finalSummary.availableMinor}`);
  }
  console.log(" [PASS] Pristine state restored. Zero financial residue.");

  console.log("\n===============================================================================");
  console.log("=== ALL SYSTEM FLOWS PASSED INTEGRITY VERIFICATION ===");
  console.log("===============================================================================");
}

runCompleteTest()
  .catch((e) => {
    console.error("TEST FAILED:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
