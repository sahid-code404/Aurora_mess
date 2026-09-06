import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { postJournal } from "@/lib/domain/ledger";
import { residentFundsSummary } from "@/lib/domain/funds";
import { lockResidentFinancialMutation } from "@/lib/domain/financial-lock";

export type RefundMode = "CARRY_FORWARD" | "ISSUE_REFUND";

export type CreateRefundInput = {
  institutionId: string;
  residentId: string;
  amountMinor: number;
  mode: RefundMode;
  reason: string;
  destination?: string | null;
  actorUserId: string;
  requestId: string;
};

export type RefundEligibilityReason =
  | "ELIGIBLE"
  | "NO_GENERATED_BILL"
  | "NO_EXCESS_CREDIT"
  | "CARRIED_FORWARD";

export type RefundEligibility = {
  residentId: string;
  eligible: boolean;
  reason: RefundEligibilityReason;
  refundableMinor: number;
  summary: Awaited<ReturnType<typeof residentFundsSummary>>;
  latestBill: {
    id: string;
    billNumber: string;
    billingPeriodId: string;
    year: number;
    month: number;
    generatedAt: Date;
  } | null;
  carriedForwardAt: Date | null;
};

/**
 * Determine whether a resident has an excess credit that may be resolved now.
 *
 * Refund lifecycle invariant:
 *   approved resident payment pool -> generated bill(s) -> bill settlement ->
 *   resident-level excess credit -> ISSUE_REFUND or CARRY_FORWARD.
 * Refunds are intentionally not attributed to one arbitrary payment.
 *
 * A positive advance before the first generated bill is intentionally NOT
 * refundable. CARRY_FORWARD resolves the whole remaining excess for the latest
 * generated bill cycle without removing the money from the resident balance;
 * another refund decision becomes available only after a newer bill exists.
 */
export async function refundEligibilityForResident(
  residentId: string,
  client: any = db
): Promise<RefundEligibility> {
  const resident = await client.user.findUnique({
    where: { id: residentId },
    select: { id: true, institutionId: true, role: true },
  });
  if (!resident || resident.role !== "RESIDENT") {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }

  const [summary, latestBill] = await Promise.all([
    residentFundsSummary(resident.id, client),
    client.bill.findFirst({
      where: {
        residentId: resident.id,
        institutionId: resident.institutionId,
        status: { not: "VOIDED" },
        period: { status: { in: ["BILLED", "REOPENED"] } },
      },
      orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      include: { period: { select: { id: true, year: true, month: true } } },
    }),
  ]);

  const refundableMinor = Math.max(0, summary.availableMinor);
  if (!latestBill) {
    return {
      residentId: resident.id,
      eligible: false,
      reason: "NO_GENERATED_BILL",
      refundableMinor: 0,
      summary,
      latestBill: null,
      carriedForwardAt: null,
    };
  }

  const carriedForward = await client.refund.findFirst({
    where: {
      institutionId: resident.institutionId,
      residentId: resident.id,
      status: "COMPLETED",
      mode: "CARRY_FORWARD",
      createdAt: { gte: latestBill.generatedAt },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  });

  const bill = {
    id: latestBill.id,
    billNumber: latestBill.billNumber,
    billingPeriodId: latestBill.billingPeriodId,
    year: latestBill.period.year,
    month: latestBill.period.month,
    generatedAt: latestBill.generatedAt,
  };

  if (carriedForward) {
    return {
      residentId: resident.id,
      eligible: false,
      reason: "CARRIED_FORWARD",
      refundableMinor,
      summary,
      latestBill: bill,
      carriedForwardAt: carriedForward.createdAt,
    };
  }

  if (refundableMinor <= 0) {
    return {
      residentId: resident.id,
      eligible: false,
      reason: "NO_EXCESS_CREDIT",
      refundableMinor: 0,
      summary,
      latestBill: bill,
      carriedForwardAt: null,
    };
  }

  return {
    residentId: resident.id,
    eligible: true,
    reason: "ELIGIBLE",
    refundableMinor,
    summary,
    latestBill: bill,
    carriedForwardAt: null,
  };
}

/**
 * Create a refund atomically.
 *
 * The resident financial mutex is the concurrency authority. We deliberately
 * use PostgreSQL READ COMMITTED (Prisma's default) rather than SERIALIZABLE:
 * when a refund waits behind billing/payment/adjustment work, the statements
 * after the lock must observe the transaction that just committed ahead of it.
 * Concurrent refunds are still serialized by the same resident row lock.
 * ISSUE_REFUND creates the domain row as PROCESSING, posts the refund journal,
 * then marks it COMPLETED inside the same transaction.
 */
export async function createRefund(input: CreateRefundInput) {
  // residentFundsSummary reads institution settings through the cached
  // institution service; pre-warm it before entering the write transaction.
  await getInstitution(input.institutionId);

  return db.$transaction(async (tx) => {
    // This is intentionally the first database statement in the transaction.
    // A waiter resumes under READ COMMITTED and all subsequent eligibility reads
    // see the billing/payment/adjustment state that committed ahead of it.
    await lockResidentFinancialMutation(tx, input.institutionId, input.residentId);

    const resident = await tx.user.findFirst({
      where: { id: input.residentId, institutionId: input.institutionId, role: "RESIDENT" },
      include: { profile: { select: { fullName: true } } },
    });
    if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);

    const eligibility = await refundEligibilityForResident(resident.id, tx);
    if (!eligibility.eligible) {
      const message =
        eligibility.reason === "NO_GENERATED_BILL"
          ? "Refunds become available only after this resident has a generated bill."
          : eligibility.reason === "CARRIED_FORWARD"
            ? "This bill cycle's excess credit was already carried forward. A new refund decision opens after the next bill is generated."
            : "This resident has no post-billing excess credit available to refund.";
      throw new ApiError(CODES.REFUND_NOT_ELIGIBLE, message, 409);
    }

    const creditable = eligibility.refundableMinor;
    if (input.amountMinor > creditable) {
      throw new ApiError(
        CODES.INSUFFICIENT_REFUND_CREDIT,
        `This resident only has ${formatMinor(Math.max(0, creditable))} available to refund.`,
        422
      );
    }
    if (input.mode === "CARRY_FORWARD" && input.amountMinor !== creditable) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Carry forward resolves the full excess credit for this bill cycle. Choose the full available amount.",
        422,
        { amount: `Use the full excess credit of ${formatMinor(creditable)}.` }
      );
    }

    const created = await tx.refund.create({
      data: {
        institutionId: input.institutionId,
        residentId: resident.id,
        paymentId: null,
        amountMinor: input.amountMinor,
        mode: input.mode,
        reason: input.reason,
        destination: input.destination ?? null,
        status: input.mode === "ISSUE_REFUND" ? "PROCESSING" : "COMPLETED",
        journalId: null,
        createdByUserId: input.actorUserId,
        completedAt: input.mode === "CARRY_FORWARD" ? new Date() : null,
      },
    });

    let journalId: string | null = null;
    let completed = created;
    if (input.mode === "ISSUE_REFUND") {
      const journal = await postJournal(
        {
          institutionId: input.institutionId,
          refType: "REFUND",
          refId: created.id,
          description: `Refund to ${resident.profile?.fullName ?? "Resident"} (${input.reason})`,
          createdByUserId: input.actorUserId,
          lines: [
            { accountCode: "RESIDENT_FUNDS", debitMinor: input.amountMinor },
            { accountCode: "CASH", creditMinor: input.amountMinor },
          ],
        },
        tx
      );
      journalId = journal.journalId;
      completed = await tx.refund.update({
        where: { id: created.id },
        data: { status: "COMPLETED", journalId, completedAt: new Date() },
      });
    }

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "REFUND_ISSUED",
        entityType: "REFUND",
        entityId: created.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: formatMinor(creditable),
        afterSummary: input.mode,
        metadata: {
          amountMinor: input.amountMinor,
          mode: input.mode,
          residentId: resident.id,
          journalId,
          journalRefId: input.mode === "ISSUE_REFUND" ? created.id : null,
          billingPeriodId: eligibility.latestBill?.billingPeriodId ?? null,
          billId: eligibility.latestBill?.id ?? null,
          billNumber: eligibility.latestBill?.billNumber ?? null,
        },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: resident.id,
        institutionId: input.institutionId,
        type: "REFUND_ISSUED",
        title: input.mode === "ISSUE_REFUND" ? "Refund issued" : "Excess credit carried forward",
        message:
          input.mode === "ISSUE_REFUND"
            ? `A refund of ${formatMinor(input.amountMinor)} has been issued for you — ${input.reason}`
            : `Your excess credit of ${formatMinor(input.amountMinor)} was carried forward for future bills — ${input.reason}`,
        entityRef: created.id,
      },
      tx
    );

    // Defense in depth: after the write, the same locked transaction must still
    // report non-negative available credit.
    const summaryAfter = await residentFundsSummary(resident.id, tx);
    if (summaryAfter.availableMinor < 0) {
      throw new ApiError(
        CODES.INSUFFICIENT_REFUND_CREDIT,
        `This resident only has ${formatMinor(Math.max(0, eligibility.summary.availableMinor))} available to refund.`,
        422
      );
    }

    return completed;
  });
}
