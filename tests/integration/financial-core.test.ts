import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  ensureAccounts,
  getAccountBalances,
  postJournal,
  reconcileInstitution,
} from "@/lib/domain/ledger";
import { recomputeBillSettlement, residentFundsSummary } from "@/lib/domain/funds";
import { createRefund } from "@/lib/domain/refunds";
import {
  billingSnapshotChecksum,
  verifyBillingPeriodIntegrity,
} from "@/lib/domain/billing-integrity";
import { removePeriodBills } from "@/lib/domain/billing";
import { invalidateInstitutionCache } from "@/lib/institution";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createInstitution(opts?: { deficitThresholdMinor?: number; gracePeriodDays?: number }) {
  const institution = await db.institution.create({
    data: {
      name: unique("Integration Mess"),
      settings: {
        create: {
          deficitThresholdMinor: opts?.deficitThresholdMinor ?? 100000,
          gracePeriodDays: opts?.gracePeriodDays ?? 7,
          restrictMealsOnDeficit: true,
          deficitPolicyEnabled: true,
        },
      },
    },
  });
  return institution;
}

async function createResident(institutionId: string) {
  return db.user.create({
    data: {
      institutionId,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("resident")}@example.test`,
      passwordHash: "integration-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
}

async function createBill(input: {
  institutionId: string;
  residentId: string;
  year: number;
  month: number;
  subtotalMinor: number;
  dueDate: Date;
  status?: string;
}) {
  const period = await db.billingPeriod.create({
    data: {
      institutionId: input.institutionId,
      year: input.year,
      month: input.month,
      status: "BILLED",
      billedAt: new Date(),
    },
  });

  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: input.institutionId,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("sha256"),
      residentCount: 1,
      residentMealCount: 0,
      guestMealCount: 0,
      eligibleExpensesMinor: 0,
      approvedPaymentsMinor: 0,
      mealChargeMinor: 0,
    },
  });

  return db.bill.create({
    data: {
      institutionId: input.institutionId,
      residentId: input.residentId,
      billingPeriodId: period.id,
      snapshotId: snapshot.id,
      billNumber: unique(`BILL-${input.year}${String(input.month).padStart(2, "0")}`),
      subtotalMinor: input.subtotalMinor,
      totalDueMinor: input.subtotalMinor,
      dueDate: input.dueDate,
      status: input.status ?? "GENERATED",
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("database-backed financial core", () => {
  test("a balanced journal persists exactly balanced debit/credit entries and account balances", async () => {
    const institution = await createInstitution();

    const { journalId } = await postJournal({
      institutionId: institution.id,
      refType: "PAYMENT",
      refId: unique("payment-ref"),
      description: "Integration payment approval",
      lines: [
        { accountCode: "CASH", debitMinor: 12500 },
        { accountCode: "RESIDENT_FUNDS", creditMinor: 12500 },
      ],
    });

    const journal = await db.ledgerJournal.findUnique({
      where: { id: journalId },
      include: { entries: { include: { account: true } } },
    });

    expect(journal).not.toBeNull();
    expect(journal?.status).toBe("POSTED");
    expect(journal?.entries).toHaveLength(2);
    expect(journal?.entries.reduce((sum, entry) => sum + entry.debitMinor, 0)).toBe(12500);
    expect(journal?.entries.reduce((sum, entry) => sum + entry.creditMinor, 0)).toBe(12500);

    const balances = await getAccountBalances(institution.id);
    const cash = balances.find((balance) => balance.code === "CASH");
    const residentFunds = balances.find((balance) => balance.code === "RESIDENT_FUNDS");
    expect(cash?.balanceMinor).toBe(12500);
    expect(residentFunds?.balanceMinor).toBe(12500);
  });

  test("an unbalanced journal is rejected before any journal row is written", async () => {
    const institution = await createInstitution();
    const before = await db.ledgerJournal.count({ where: { institutionId: institution.id } });

    await expect(
      postJournal({
        institutionId: institution.id,
        description: "Must fail",
        lines: [
          { accountCode: "CASH", debitMinor: 10000 },
          { accountCode: "RESIDENT_FUNDS", creditMinor: 9000 },
        ],
      })
    ).rejects.toThrow("Journal is unbalanced");

    const after = await db.ledgerJournal.count({ where: { institutionId: institution.id } });
    expect(after).toBe(before);
  });

  test("approved payment pool settles bills FIFO and cannot over-apply credit", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    const now = Date.now();

    const firstBill = await createBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 1,
      subtotalMinor: 10000,
      dueDate: new Date(now + 10 * 86_400_000),
    });
    const secondBill = await createBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 2,
      subtotalMinor: 5000,
      dueDate: new Date(now + 20 * 86_400_000),
    });

    await db.payment.create({
      data: {
        institutionId: institution.id,
        displayNumber: unique("PAY-202602"),
        residentId: resident.id,
        amountMinor: 12500,
        method: "UPI",
        status: "APPROVED",
      },
    });

    const result = await recomputeBillSettlement(db, resident.id);
    expect(result.poolMinor).toBe(12500);
    expect(result.unappliedMinor).toBe(0);

    const first = await db.bill.findUniqueOrThrow({ where: { id: firstBill.id } });
    const second = await db.bill.findUniqueOrThrow({ where: { id: secondBill.id } });

    expect(first.paymentsMinor).toBe(10000);
    expect(first.totalDueMinor).toBe(0);
    expect(first.status).toBe("PAID");

    expect(second.paymentsMinor).toBe(2500);
    expect(second.totalDueMinor).toBe(2500);
    expect(second.status).toBe("PARTIALLY_PAID");

    const totalApplied = first.paymentsMinor + second.paymentsMinor;
    expect(totalApplied).toBe(12500);
  });

  test("resident funds are derived from persisted financial facts and enforce deficit policy deterministically", async () => {
    const institution = await createInstitution({ deficitThresholdMinor: 1000, gracePeriodDays: 0 });
    const resident = await createResident(institution.id);

    await createBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 3,
      subtotalMinor: 5000,
      dueDate: new Date(Date.now() - 86_400_000),
      status: "OVERDUE",
    });

    invalidateInstitutionCache();
    const summary = await residentFundsSummary(resident.id);

    expect(summary.creditsMinor).toBe(0);
    expect(summary.chargesMinor).toBe(5000);
    expect(summary.availableMinor).toBe(-5000);
    expect(summary.amountToPayMinor).toBe(5000);
    expect(summary.deficitMinor).toBe(5000);
    expect(summary.thresholdMinor).toBe(1000);
    expect(summary.policyState).toBe("RESTRICTED");
  });

  test("concurrent cash refunds cannot double-spend the same resident credit", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);

    await db.payment.create({
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
    await ensureAccounts(institution.id);
    invalidateInstitutionCache();

    const attempts = await Promise.allSettled([
      createRefund({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 6000,
        mode: "ISSUE_REFUND",
        reason: "Concurrent refund A",
        actorUserId: "integration-admin-a",
        requestId: unique("refund-request-a"),
      }),
      createRefund({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 6000,
        mode: "ISSUE_REFUND",
        reason: "Concurrent refund B",
        actorUserId: "integration-admin-b",
        requestId: unique("refund-request-b"),
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);

    const refunds = await db.refund.findMany({
      where: { institutionId: institution.id, residentId: resident.id },
      orderBy: { createdAt: "asc" },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe("COMPLETED");
    expect(refunds[0].mode).toBe("ISSUE_REFUND");
    expect(refunds[0].amountMinor).toBe(6000);
    expect(refunds[0].journalId).not.toBeNull();

    const journal = await db.ledgerJournal.findUniqueOrThrow({
      where: { id: refunds[0].journalId as string },
      include: { entries: true },
    });
    expect(journal.refType).toBe("REFUND");
    expect(journal.refId).toBe(refunds[0].id);
    expect(journal.entries.reduce((sum, entry) => sum + entry.debitMinor, 0)).toBe(6000);
    expect(journal.entries.reduce((sum, entry) => sum + entry.creditMinor, 0)).toBe(6000);

    const after = await residentFundsSummary(resident.id);
    expect(after.creditsMinor).toBe(10000);
    expect(after.chargesMinor).toBe(1000);
    expect(after.refundsIssuedMinor).toBe(6000);
    expect(after.availableMinor).toBe(3000);
  });

  test("reconciliation catches missing refund and bill journals", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);

    await createBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 4,
      subtotalMinor: 5000,
      dueDate: new Date(Date.now() + 86_400_000),
    });

    await db.refund.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 1000,
        mode: "ISSUE_REFUND",
        reason: "Intentionally broken reconciliation fixture",
        status: "COMPLETED",
        journalId: null,
        createdByUserId: "integration-admin",
        completedAt: new Date(),
      },
    });

    const result = await reconcileInstitution(institution.id);
    expect(result.cashRefundsWithoutJournal).toBe(1);
    expect(result.billsWithoutJournal).toBe(1);
    expect(result.balanced).toBe(false);
    expect(result.problems.some((problem) => problem.includes("refund"))).toBe(true);
    expect(result.problems.some((problem) => problem.includes("bill"))).toBe(true);
  });

  test("billing snapshot integrity verifies a valid frozen artifact and detects payload tampering", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    const year = 2026;
    const month = 5;
    const mealChargeMinor = 500;

    const period = await db.billingPeriod.create({
      data: {
        institutionId: institution.id,
        year,
        month,
        status: "BILLED",
        billedAt: new Date(),
        closedAt: new Date(),
        mealChargeMinorSnapshot: mealChargeMinor,
        formulaVersionId: null,
      },
    });

    const payload = {
      period: { year, month, startKey: "2026-05-01", endKey: "2026-05-31" },
      formula: { versionId: null },
      residents: [{ id: resident.id }],
      totals: {
        residentCount: 1,
        residentMealCount: 2,
        guestMealCount: 0,
        eligibleExpensesMinor: 0,
        approvedPaymentsMinor: 0,
      },
    };
    const payloadJson = JSON.stringify(payload);
    const snapshot = await db.billingSnapshot.create({
      data: {
        institutionId: institution.id,
        billingPeriodId: period.id,
        payloadJson,
        checksum: billingSnapshotChecksum(payloadJson),
        residentCount: 1,
        residentMealCount: 2,
        guestMealCount: 0,
        eligibleExpensesMinor: 0,
        approvedPaymentsMinor: 0,
        mealChargeMinor,
      },
    });

    await db.bill.create({
      data: {
        institutionId: institution.id,
        residentId: resident.id,
        billingPeriodId: period.id,
        snapshotId: snapshot.id,
        billNumber: unique("BILL-INTEGRITY"),
        residentMealCount: 2,
        guestMealCount: 0,
        mealChargeMinor,
        subtotalMinor: 1000,
        totalDueMinor: 1000,
        dueDate: new Date("2026-06-05T00:00:00.000Z"),
        status: "GENERATED",
      },
    });

    const valid = await verifyBillingPeriodIntegrity(period.id);
    expect(valid.valid).toBe(true);
    expect(valid.checks.every((check) => check.pass)).toBe(true);

    const tamperedPayload = JSON.stringify({
      ...payload,
      totals: { ...payload.totals, residentMealCount: 999 },
    });
    await db.billingSnapshot.update({
      where: { id: snapshot.id },
      data: { payloadJson: tamperedPayload },
    });

    const tampered = await verifyBillingPeriodIntegrity(period.id);
    expect(tampered.valid).toBe(false);
    expect(tampered.checks.find((check) => check.key === "snapshot_checksum")?.pass).toBe(false);
    expect(tampered.checks.find((check) => check.key === "payload_aggregates")?.pass).toBe(false);
  });

  test("destructive billing reset is disabled and cannot delete posted artifacts", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    const bill = await createBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 6,
      subtotalMinor: 5000,
      dueDate: new Date(Date.now() + 86_400_000),
    });

    const { journalId } = await postJournal({
      institutionId: institution.id,
      refType: "BILL",
      refId: bill.id,
      description: "Historical bill journal that must remain immutable",
      lines: [
        { accountCode: "RESIDENT_FUNDS", debitMinor: 5000 },
        { accountCode: "MEAL_CHARGE_INCOME", creditMinor: 5000 },
      ],
    });

    const beforeBills = await db.bill.count({ where: { billingPeriodId: bill.billingPeriodId } });
    const beforeSnapshots = await db.billingSnapshot.count({ where: { billingPeriodId: bill.billingPeriodId } });
    const beforeJournals = await db.ledgerJournal.count({ where: { id: journalId } });

    await expect(removePeriodBills(bill.billingPeriodId, "integration-admin")).rejects.toThrow(
      "Destructive billing reset is disabled"
    );

    expect(await db.bill.count({ where: { billingPeriodId: bill.billingPeriodId } })).toBe(beforeBills);
    expect(await db.billingSnapshot.count({ where: { billingPeriodId: bill.billingPeriodId } })).toBe(beforeSnapshots);
    expect(await db.ledgerJournal.count({ where: { id: journalId } })).toBe(beforeJournals);
  });
});
