import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { ensureAccounts } from "@/lib/domain/ledger";
import { recomputeBillSettlement, residentFundsSummary } from "@/lib/domain/funds";
import {
  createRefund,
  refundEligibilityForResident,
} from "@/lib/domain/refunds";
import { invalidateInstitutionCache } from "@/lib/institution";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createInstitution() {
  return db.institution.create({
    data: {
      name: unique("Refund Lifecycle Mess"),
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
      email: `${unique("refund-resident")}@example.test`,
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
  return db.payment.create({
    data: {
      institutionId,
      displayNumber: unique("PAY-REFUND-LIFECYCLE"),
      residentId,
      amountMinor,
      method: "UPI",
      status: "APPROVED",
    },
  });
}

async function createGeneratedBill(input: {
  institutionId: string;
  residentId: string;
  year: number;
  month: number;
  subtotalMinor: number;
  generatedAt?: Date;
}) {
  const period = await db.billingPeriod.create({
    data: {
      institutionId: input.institutionId,
      year: input.year,
      month: input.month,
      status: "BILLED",
      billedAt: input.generatedAt ?? new Date(),
      closedAt: input.generatedAt ?? new Date(),
    },
  });

  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: input.institutionId,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("refund-lifecycle-snapshot"),
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
      dueDate: new Date("2027-01-31T00:00:00.000Z"),
      status: "GENERATED",
      ...(input.generatedAt
        ? { generatedAt: input.generatedAt, createdAt: input.generatedAt }
        : {}),
    },
  });
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
    actorUserId: "phase18-integration-admin",
    requestId: unique("phase18-refund-request"),
  };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("post-billing refund lifecycle", () => {
  test("advance credit cannot be refunded before any bill is generated", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    invalidateInstitutionCache();

    const eligibility = await refundEligibilityForResident(resident.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("NO_GENERATED_BILL");
    expect(eligibility.refundableMinor).toBe(0);

    let caught: unknown;
    try {
      await createRefund(
        refundInput({
          institutionId: institution.id,
          residentId: resident.id,
          amountMinor: 1_000,
          mode: "ISSUE_REFUND",
          reason: "Must wait for billing",
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe(CODES.REFUND_NOT_ELIGIBLE);
    expect(
      await db.refund.count({ where: { institutionId: institution.id, residentId: resident.id } })
    ).toBe(0);
  });

  test("a generated bill exposes only the true approved excess as refundable", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    const bill = await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 1,
      subtotalMinor: 6_000,
    });
    await recomputeBillSettlement(db, resident.id);
    invalidateInstitutionCache();

    const storedBill = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(storedBill.status).toBe("PAID");
    expect(storedBill.totalDueMinor).toBe(0);
    expect(storedBill.paymentsMinor).toBe(6_000);

    const eligibility = await refundEligibilityForResident(resident.id);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reason).toBe("ELIGIBLE");
    expect(eligibility.refundableMinor).toBe(4_000);
    expect(eligibility.latestBill?.id).toBe(bill.id);
  });

  test("partial cash payout leaves only the unreturned excess eligible", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 2,
      subtotalMinor: 6_000,
    });
    await recomputeBillSettlement(db, resident.id);
    await ensureAccounts(institution.id);
    invalidateInstitutionCache();

    const refund = await createRefund(
      refundInput({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 1_500,
        mode: "ISSUE_REFUND",
        reason: "Partial excess payout",
      })
    );
    expect(refund.status).toBe("COMPLETED");
    expect(refund.journalId).not.toBeNull();

    const eligibility = await refundEligibilityForResident(resident.id);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.refundableMinor).toBe(2_500);

    const summary = await residentFundsSummary(resident.id);
    expect(summary.creditsMinor).toBe(10_000);
    expect(summary.chargesMinor).toBe(6_000);
    expect(summary.refundsIssuedMinor).toBe(1_500);
    expect(summary.availableMinor).toBe(2_500);
  });

  test("carry forward must resolve the full excess and closes the current bill cycle", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 3,
      subtotalMinor: 6_000,
    });
    await recomputeBillSettlement(db, resident.id);
    invalidateInstitutionCache();

    await expect(
      createRefund(
        refundInput({
          institutionId: institution.id,
          residentId: resident.id,
          amountMinor: 1_000,
          mode: "CARRY_FORWARD",
          reason: "Partial carry forward must fail",
        })
      )
    ).rejects.toThrow("full excess credit");

    const carried = await createRefund(
      refundInput({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 4_000,
        mode: "CARRY_FORWARD",
        reason: "Keep excess for the next bill",
      })
    );
    expect(carried.status).toBe("COMPLETED");
    expect(carried.mode).toBe("CARRY_FORWARD");
    expect(carried.journalId).toBeNull();

    const summary = await residentFundsSummary(resident.id);
    expect(summary.availableMinor).toBe(4_000);
    expect(summary.carryForwardMinor).toBe(4_000);

    const eligibility = await refundEligibilityForResident(resident.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("CARRIED_FORWARD");
    expect(eligibility.refundableMinor).toBe(4_000);
  });

  test("a newer generated bill reopens the carried-forward excess decision", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    const firstGeneratedAt = new Date(Date.now() - 120_000);
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 4,
      subtotalMinor: 6_000,
      generatedAt: firstGeneratedAt,
    });
    await recomputeBillSettlement(db, resident.id);
    invalidateInstitutionCache();

    await createRefund(
      refundInput({
        institutionId: institution.id,
        residentId: resident.id,
        amountMinor: 4_000,
        mode: "CARRY_FORWARD",
        reason: "Carry excess into the next period",
      })
    );

    const closed = await refundEligibilityForResident(resident.id);
    expect(closed.reason).toBe("CARRIED_FORWARD");

    const secondGeneratedAt = new Date(Date.now() + 120_000);
    const secondBill = await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 5,
      subtotalMinor: 1_000,
      generatedAt: secondGeneratedAt,
    });
    await recomputeBillSettlement(db, resident.id);

    const reopened = await refundEligibilityForResident(resident.id);
    expect(reopened.eligible).toBe(true);
    expect(reopened.reason).toBe("ELIGIBLE");
    expect(reopened.latestBill?.id).toBe(secondBill.id);
    expect(reopened.refundableMinor).toBe(3_000);
  });

  test("concurrent post-billing cash payouts cannot double-spend the same excess", async () => {
    const institution = await createInstitution();
    const resident = await createResident(institution.id);
    await createApprovedPayment(institution.id, resident.id, 10_000);
    await createGeneratedBill({
      institutionId: institution.id,
      residentId: resident.id,
      year: 2026,
      month: 6,
      subtotalMinor: 1_000,
    });
    await recomputeBillSettlement(db, resident.id);
    await ensureAccounts(institution.id);
    invalidateInstitutionCache();

    const attempts = await Promise.allSettled([
      createRefund(
        refundInput({
          institutionId: institution.id,
          residentId: resident.id,
          amountMinor: 6_000,
          mode: "ISSUE_REFUND",
          reason: "Concurrent payout A",
        })
      ),
      createRefund(
        refundInput({
          institutionId: institution.id,
          residentId: resident.id,
          amountMinor: 6_000,
          mode: "ISSUE_REFUND",
          reason: "Concurrent payout B",
        })
      ),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);

    const refunds = await db.refund.findMany({
      where: {
        institutionId: institution.id,
        residentId: resident.id,
        mode: "ISSUE_REFUND",
        status: "COMPLETED",
      },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountMinor).toBe(6_000);

    const summary = await residentFundsSummary(resident.id);
    expect(summary.chargesMinor).toBe(1_000);
    expect(summary.refundsIssuedMinor).toBe(6_000);
    expect(summary.availableMinor).toBe(3_000);
  });
});
