import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { postJournal, reconcileInstitution } from "@/lib/domain/ledger";
import { recomputeBillSettlement, residentFundsSummary } from "@/lib/domain/funds";
import { createRefund, refundEligibilityForResident } from "@/lib/domain/refunds";
import { voidRefund } from "@/lib/domain/refund-correction";
import { invalidateInstitutionCache } from "@/lib/institution";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createInstitution() {
  return db.institution.create({
    data: {
      name: unique("Refund Correction Mess"),
      settings: {
        create: {
          deficitThresholdMinor: 100000,
          gracePeriodDays: 7,
          restrictMealsOnDeficit: true,
          deficitPolicyEnabled: true,
        },
      },
    },
  });
}

async function createResident(institutionId: string) {
  return db.user.create({
    data: {
      institutionId,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("phase45-resident")}@example.test`,
      passwordHash: "integration-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
}

async function createApprovedPayment(
  institutionId: string,
  residentId: string,
  amountMinor: number
) {
  const payment = await db.payment.create({
    data: {
      institutionId,
      displayNumber: unique("PAY-P45"),
      residentId,
      amountMinor,
      method: "UPI",
      status: "APPROVED",
      reviewedAt: new Date(),
      reviewedByUserId: "phase45-admin",
    },
  });

  const { journalId } = await postJournal({
    institutionId,
    refType: "PAYMENT",
    refId: payment.id,
    description: `Phase 45 approved payment ${payment.displayNumber}`,
    createdByUserId: "phase45-admin",
    lines: [
      { accountCode: "CASH", debitMinor: amountMinor },
      { accountCode: "RESIDENT_FUNDS", creditMinor: amountMinor },
    ],
  });

  return db.payment.update({
    where: { id: payment.id },
    data: { approvedJournalId: journalId },
  });
}

async function createGeneratedBill(input: {
  institutionId: string;
  residentId: string;
  year: number;
  month: number;
  subtotalMinor: number;
  dueDate: Date;
}) {
  const period = await db.billingPeriod.create({
    data: {
      institutionId: input.institutionId,
      year: input.year,
      month: input.month,
      status: "BILLED",
      billedAt: new Date(),
      closedAt: new Date(),
    },
  });

  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: input.institutionId,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("phase45-snapshot"),
      residentCount: 1,
      residentMealCount: 0,
      guestMealCount: 0,
      eligibleExpensesMinor: 0,
      approvedPaymentsMinor: 0,
      mealChargeMinor: 0,
    },
  });

  const bill = await db.bill.create({
    data: {
      institutionId: input.institutionId,
      residentId: input.residentId,
      billingPeriodId: period.id,
      snapshotId: snapshot.id,
      billNumber: unique(`BILL-P45-${input.year}${String(input.month).padStart(2, "0")}`),
      subtotalMinor: input.subtotalMinor,
      totalDueMinor: input.subtotalMinor,
      paymentsMinor: 0,
      dueDate: input.dueDate,
      status: "GENERATED",
    },
  });

  await postJournal({
    institutionId: input.institutionId,
    refType: "BILL",
    refId: bill.id,
    description: `Phase 45 bill ${bill.billNumber}`,
    createdByUserId: "phase45-admin",
    lines: [
      { accountCode: "RESIDENT_FUNDS", debitMinor: input.subtotalMinor },
      { accountCode: "MEAL_CHARGE_INCOME", creditMinor: input.subtotalMinor },
    ],
  });

  return bill;
}

function refundInput(input: {
  institutionId: string;
  residentId: string;
  amountMinor: number;
  mode: "ISSUE_REFUND" | "CARRY_FORWARD";
  reason: string;
}) {
  return {
    ...input,
    actorUserId: "phase45-admin",
    requestId: unique("phase45-refund-request"),
  };
}

function voidInput(institutionId: string, refundId: string, reason: string) {
  return {
    institutionId,
    refundId,
    reason,
    actorUserId: "phase45-admin",
    requestId: unique("phase45-void-request"),
  };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("refund correction lifecycle", () => {
  test("voiding a completed cash refund restores pooled credit, re-settles newer bills and reconciles", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    const firstBill = await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 1,
      subtotalMinor: 3_000,
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    });
    invalidateInstitutionCache();

    const firstSettlement = await recomputeBillSettlement(db, resident.id);
    expect(firstSettlement.poolMinor).toBe(10_000);
    expect((await db.bill.findUniqueOrThrow({ where: { id: firstBill.id } })).status).toBe("PAID");

    const refund = await createRefund(
      refundInput({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 5_000,
        mode: "ISSUE_REFUND",
        reason: "Phase 45 payout before a later bill",
      })
    );
    expect(refund.status).toBe("COMPLETED");
    expect(refund.journalId).not.toBeNull();

    const secondBill = await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 2,
      subtotalMinor: 4_000,
      dueDate: new Date(Date.now() + 60 * 86_400_000),
    });

    // Settlement must use spendable resident cash, not gross approved receipts.
    const refundedSettlement = await recomputeBillSettlement(db, resident.id);
    expect(refundedSettlement.poolMinor).toBe(5_000);
    const beforeCorrection = await db.bill.findUniqueOrThrow({ where: { id: secondBill.id } });
    expect(beforeCorrection.paymentsMinor).toBe(2_000);
    expect(beforeCorrection.totalDueMinor).toBe(2_000);
    expect(beforeCorrection.status).toBe("PARTIALLY_PAID");

    const beforeSummary = await residentFundsSummary(resident.id);
    expect(beforeSummary.creditsMinor).toBe(10_000);
    expect(beforeSummary.chargesMinor).toBe(7_000);
    expect(beforeSummary.refundsIssuedMinor).toBe(5_000);
    expect(beforeSummary.availableMinor).toBe(-2_000);

    const corrected = await voidRefund(
      voidInput(institution.id, refund.id, "Payout was returned to the mess account")
    );
    expect(corrected.status).toBe("VOIDED");
    expect(corrected.reversalJournalId).not.toBeNull();
    expect(corrected.voidReason).toBe("Payout was returned to the mess account");
    expect(corrected.voidedByUserId).toBe("phase45-admin");
    expect(corrected.voidedAt).not.toBeNull();

    const originalJournal = await db.ledgerJournal.findUniqueOrThrow({ where: { id: refund.journalId as string } });
    expect(originalJournal.status).toBe("REVERSED");
    expect(originalJournal.reversedByJournalId).toBe(corrected.reversalJournalId);

    const reversalJournal = await db.ledgerJournal.findUniqueOrThrow({
      where: { id: corrected.reversalJournalId as string },
      include: { entries: { include: { account: { select: { code: true } } } } },
    });
    expect(reversalJournal.status).toBe("POSTED");
    expect(reversalJournal.refType).toBe("REFUND");
    expect(reversalJournal.refId).toBe(refund.id);
    expect(
      reversalJournal.entries.find((entry) => entry.account.code === "CASH")?.debitMinor
    ).toBe(5_000);
    expect(
      reversalJournal.entries.find((entry) => entry.account.code === "RESIDENT_FUNDS")?.creditMinor
    ).toBe(5_000);

    const afterSummary = await residentFundsSummary(resident.id);
    expect(afterSummary.refundsIssuedMinor).toBe(0);
    expect(afterSummary.availableMinor).toBe(3_000);

    const afterCorrection = await db.bill.findUniqueOrThrow({ where: { id: secondBill.id } });
    expect(afterCorrection.paymentsMinor).toBe(4_000);
    expect(afterCorrection.totalDueMinor).toBe(0);
    expect(afterCorrection.status).toBe("PAID");

    const reopened = await refundEligibilityForResident(resident.id);
    expect(reopened.eligible).toBe(true);
    expect(reopened.refundableMinor).toBe(3_000);

    const reconciliation = await reconcileInstitution(institution.id);
    expect(reconciliation.balanced).toBe(true);
    expect(reconciliation.voidedCashRefundsWithoutReversalJournal).toBe(0);
    expect(reconciliation.refundReversalLinkMismatches).toBe(0);
    expect(reconciliation.refundInvalidLifecycleRows).toBe(0);

    let duplicateVoid: unknown;
    try {
      await voidRefund(voidInput(institution.id, refund.id, "Second correction must fail"));
    } catch (error) {
      duplicateVoid = error;
    }
    expect(duplicateVoid).toBeInstanceOf(ApiError);
    expect((duplicateVoid as ApiError).code).toBe(CODES.REFUND_INVALID_STATE);
  });

  test("voiding a carry-forward keeps money on-ledger and reopens the same bill-cycle decision", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 3,
      subtotalMinor: 3_000,
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    });
    invalidateInstitutionCache();
    await recomputeBillSettlement(db, resident.id);

    const carried = await createRefund(
      refundInput({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 7_000,
        mode: "CARRY_FORWARD",
        reason: "Keep the full excess for the next bill",
      })
    );
    expect(carried.journalId).toBeNull();

    const closed = await refundEligibilityForResident(resident.id);
    expect(closed.eligible).toBe(false);
    expect(closed.reason).toBe("CARRIED_FORWARD");

    const corrected = await voidRefund(
      voidInput(institution.id, carried.id, "Resident requested a different refund decision")
    );
    expect(corrected.status).toBe("VOIDED");
    expect(corrected.journalId).toBeNull();
    expect(corrected.reversalJournalId).toBeNull();

    const summary = await residentFundsSummary(resident.id);
    expect(summary.availableMinor).toBe(7_000);
    expect(summary.carryForwardMinor).toBe(0);

    const reopened = await refundEligibilityForResident(resident.id);
    expect(reopened.eligible).toBe(true);
    expect(reopened.reason).toBe("ELIGIBLE");
    expect(reopened.refundableMinor).toBe(7_000);

    const reconciliation = await reconcileInstitution(institution.id);
    expect(reconciliation.balanced).toBe(true);
    expect(reconciliation.voidedCarryForwardsWithJournal).toBe(0);
  });

  test("correction fails closed when a completed refund already carries ambiguous correction provenance", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 4,
      subtotalMinor: 3_000,
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    });
    invalidateInstitutionCache();
    await recomputeBillSettlement(db, resident.id);

    const refund = await createRefund(
      refundInput({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 2_000,
        mode: "ISSUE_REFUND",
        reason: "Fixture payout",
      })
    );
    await db.refund.update({
      where: { id: refund.id },
      data: { voidReason: "Corrupted pre-existing correction marker" },
    });
    const journalCountBefore = await db.ledgerJournal.count({ where: { institutionId: institution.id } });

    let caught: unknown;
    try {
      await voidRefund(voidInput(institution.id, refund.id, "Must not overwrite provenance"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe(CODES.RESOURCE_CHANGED);

    const unchanged = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(unchanged.status).toBe("COMPLETED");
    expect(unchanged.reversalJournalId).toBeNull();
    expect(unchanged.voidReason).toBe("Corrupted pre-existing correction marker");
    expect(await db.ledgerJournal.count({ where: { institutionId: institution.id } })).toBe(journalCountBefore);
    expect((await db.ledgerJournal.findUniqueOrThrow({ where: { id: refund.journalId as string } })).status).toBe("POSTED");
  });

  test("reconciliation rejects dead persisted refund states instead of silently ignoring them", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);

    await db.refund.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 1_000,
        mode: "CARRY_FORWARD",
        reason: "Legacy dead-state fixture",
        status: "PENDING",
        createdByUserId: "phase45-admin",
      },
    });

    const reconciliation = await reconcileInstitution(institution.id);
    expect(reconciliation.refundInvalidLifecycleRows).toBe(1);
    expect(reconciliation.balanced).toBe(false);
    expect(
      reconciliation.problems.some((problem) => problem.includes("unsupported persisted lifecycle state"))
    ).toBe(true);
  });
});
