import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { getAccountBalances, postJournal } from "@/lib/domain/ledger";
import { recomputeBillSettlement, residentFundsSummary } from "@/lib/domain/funds";
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
    expect(journal?.entries.reduce((sum, e) => sum + e.debitMinor, 0)).toBe(12500);
    expect(journal?.entries.reduce((sum, e) => sum + e.creditMinor, 0)).toBe(12500);

    const balances = await getAccountBalances(institution.id);
    const cash = balances.find((b) => b.code === "CASH");
    const residentFunds = balances.find((b) => b.code === "RESIDENT_FUNDS");
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
});
