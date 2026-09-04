import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { formatMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { postJournal } from "@/lib/domain/ledger";
import { residentFundsSummary } from "@/lib/domain/funds";

export type RefundMode = "CARRY_FORWARD" | "ISSUE_REFUND";

export type CreateRefundInput = {
  institutionId: string;
  residentId: string;
  amountMinor: number;
  mode: RefundMode;
  reason: string;
  paymentId?: string | null;
  destination?: string | null;
  actorUserId: string;
  requestId: string;
};

function isSerializationConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2034";
}

/** PostgreSQL-safe serializable write with a small bounded retry. */
async function serializableWrite<T>(work: (tx: any) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!isSerializationConflict(error) || attempt === 3) throw error;
    }
  }
  throw lastError;
}

/**
 * Create a refund atomically.
 *
 * The available-credit read and refund write run at SERIALIZABLE isolation so
 * two admins cannot spend the same resident credit concurrently on PostgreSQL.
 * ISSUE_REFUND creates the domain row first as PROCESSING, posts a journal that
 * references the refund ID itself, then marks the row COMPLETED. Any failure
 * rolls the entire transaction back, so PROCESSING is never left behind by a
 * synchronous request failure.
 */
export async function createRefund(input: CreateRefundInput) {
  // residentFundsSummary reads institution settings through the cached
  // institution service; pre-warm it before entering the serializable tx.
  await getInstitution(input.institutionId);

  return serializableWrite(async (tx) => {
    const resident = await tx.user.findFirst({
      where: { id: input.residentId, institutionId: input.institutionId, role: "RESIDENT" },
      include: { profile: { select: { fullName: true } } },
    });
    if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);

    if (input.paymentId) {
      const payment = await tx.payment.findFirst({
        where: {
          id: input.paymentId,
          institutionId: input.institutionId,
          residentId: resident.id,
        },
        select: { id: true },
      });
      if (!payment) {
        throw new ApiError(CODES.VALIDATION_FAILED, "The linked payment does not belong to this resident.", 400, {
          paymentId: "The linked payment does not belong to this resident.",
        });
      }
    }

    const summaryBefore = await residentFundsSummary(resident.id, tx);
    const creditable = summaryBefore.availableMinor;
    if (input.amountMinor > creditable) {
      throw new ApiError(
        CODES.INSUFFICIENT_REFUND_CREDIT,
        `This resident only has ${formatMinor(Math.max(0, creditable))} available to refund.`,
        422
      );
    }

    const created = await tx.refund.create({
      data: {
        institutionId: input.institutionId,
        residentId: resident.id,
        paymentId: input.paymentId ?? null,
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
        beforeSummary: "—",
        afterSummary: input.mode,
        metadata: {
          amountMinor: input.amountMinor,
          mode: input.mode,
          residentId: resident.id,
          paymentId: input.paymentId ?? null,
          journalId,
          journalRefId: input.mode === "ISSUE_REFUND" ? created.id : null,
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
        title: input.mode === "ISSUE_REFUND" ? "Refund issued" : "Excess credit noted",
        message:
          input.mode === "ISSUE_REFUND"
            ? `A refund of ${formatMinor(input.amountMinor)} has been issued for you — ${input.reason}`
            : `An excess credit of ${formatMinor(input.amountMinor)} was noted on your account — it stays available for future bills.`,
        entityRef: created.id,
      },
      tx
    );

    // Defense in depth. SERIALIZABLE isolation is the concurrency guarantee;
    // this assertion also catches future calculation changes that could make a
    // successful refund overdraw resident credit within the same transaction.
    const summaryAfter = await residentFundsSummary(resident.id, tx);
    if (summaryAfter.availableMinor < 0) {
      throw new ApiError(
        CODES.INSUFFICIENT_REFUND_CREDIT,
        `This resident only has ${formatMinor(Math.max(0, summaryBefore.availableMinor))} available to refund.`,
        422
      );
    }

    return completed;
  });
}
