/**
 * /api/v1/payments (auth RESIDENT)
 *
 * POST — submit a payment for review (spec §37-38).
 *   multipart/form-data: amount (decimal string), method (UPI|CASH|BANK_TRANSFER|OTHER),
 *   reference?, notes?, proof? (JPEG/PNG/PDF ≤ 2 MB), idempotencyKey? (uuid).
 *   - Rate limited 10/hour per client.
 *   - Idempotent: an existing PAYMENT_SUBMIT key replays the stored response.
 *   - residentId is ALWAYS derived from the session — never client-supplied.
 *   - No journal yet: approval (admin) posts Dr CASH / Cr RESIDENT_FUNDS.
 *
 * GET — own payments with status filter + cursor. Meta carries this month's
 *   approved deposits, pending payment count and pending refund count.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { getInstitution } from "@/lib/institution";
import { appendAudit } from "@/lib/audit";
import { parseDecimalToMinor, formatMinor } from "@/lib/money";
import { nextPaymentNumber } from "@/lib/ids";
import { claimIdempotencyKey, completeIdempotencyKey } from "@/lib/idempotency";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { paymentMethodSchema } from "@/lib/validation";
import { storeUpload } from "@/lib/storage";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";
import { finishPage, formFile, formText, keysetWhere, readFormData } from "@/lib/domain/http";
import { serializePayment } from "@/lib/domain/serialize";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import { residentFundsSummary } from "@/lib/domain/funds";

export const dynamic = "force-dynamic";

const MAX_PAYMENT_MINOR = 100_000_000; // ₹10,00,000.00 — sanity ceiling, documented

// ---------------------------------------------------------------------------
// POST — submit
// ---------------------------------------------------------------------------
export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  const rl = await rateLimit(clientKey(ctx.req, "payment-submit"), 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(
      CODES.RATE_LIMITED,
      `You've submitted several payments recently — try again in ${rl.retryAfterSec} seconds.`,
      429
    );
  }

  const form = await readFormData(ctx.req);
  const amountRaw = formText(form, "amount");
  const methodRaw = formText(form, "method");
  const reference = formText(form, "reference");
  const notes = formText(form, "notes");
  const idempotencyKey = formText(form, "idempotencyKey");
  const proof = formFile(form, "proof");

  const fields: Record<string, string> = {};
  const method = paymentMethodSchema.safeParse(methodRaw ?? "");
  if (!method.success) fields.method = "Choose a payment method.";
  const amountMinor = amountRaw ? parseDecimalToMinor(amountRaw) : null;
  if (amountMinor === null || amountMinor <= 0) {
    fields.amount = "Enter a valid amount greater than zero.";
  } else if (amountMinor > MAX_PAYMENT_MINOR) {
    fields.amount = "Payments up to ₹10,00,000.00 are supported.";
  }
  if (reference && reference.length > 80) fields.reference = "Keep the reference under 80 characters.";
  if (notes && notes.length > 500) fields.notes = "Keep the notes under 500 characters.";
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 100)) {
    fields.idempotencyKey = "The idempotency key must be 8–100 characters (a UUID is recommended).";
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, fields);
  }

  // Fast replay before file storage/number allocation. Only an unexpired row is
  // eligible for replay; expired rows must flow through the transactional claim
  // path so they can be atomically reclaimed.
  if (idempotencyKey) {
    const replayNow = new Date();
    const existing = await db.idempotencyRecord.findUnique({
      where: { institutionId_scope_key: { institutionId: ctx.institutionId, scope: "PAYMENT_SUBMIT", key: idempotencyKey } },
    });
    if (existing?.responseJson && existing.expiresAt.getTime() > replayNow.getTime()) {
      return { data: JSON.parse(existing.responseJson), meta: { idempotentReplay: true } };
    }
  }

  // File storage + display number are prepared BEFORE the transaction. A
  // rollback may therefore leave a harmless orphan file/number gap.
  const proofFile = proof ? await storeUpload(proof, ctx.institutionId, ctx.user.id) : null;
  const displayNumber = await nextPaymentNumber();

  const result = await db.$transaction(async (tx) => {
    if (idempotencyKey) {
      const claim = await claimIdempotencyKey({
        client: tx,
        institutionId: ctx.institutionId,
        scope: "PAYMENT_SUBMIT",
        key: idempotencyKey,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      if (claim.state === "REPLAY") {
        return { replay: true as const, payload: claim.payload };
      }
      if (claim.state === "IN_PROGRESS") {
        throw new ApiError(
          CODES.IDPOTENCY_CONFLICT,
          "This request is already being processed. Please try again in a moment.",
          409
        );
      }
    }

    const payment = await tx.payment.create({
      data: {
        institutionId: ctx.institutionId,
        displayNumber,
        residentId: ctx.user.id, // NEVER client-supplied
        amountMinor: amountMinor as number,
        method: method.data!,
        reference: reference ?? null,
        notes: notes ?? null,
        status: "PENDING",
        idempotencyKey: idempotencyKey ?? null,
        proofFileId: proofFile?.id ?? null,
      },
    });
    await tx.paymentStatusHistory.create({
      data: {
        paymentId: payment.id,
        fromStatus: null,
        toStatus: "PENDING",
        changedByUserId: ctx.user.id,
      },
    });

    const payload = serializePayment(payment);

    if (idempotencyKey) {
      await completeIdempotencyKey({
        client: tx,
        institutionId: ctx.institutionId,
        scope: "PAYMENT_SUBMIT",
        key: idempotencyKey,
        payload,
      });
    }

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "PAYMENT_SUBMITTED",
        entityType: "PAYMENT",
        entityId: payment.id,
        requestId: ctx.requestId,
        beforeSummary: null,
        afterSummary: "PENDING",
        metadata: {
          amountMinor: payment.amountMinor,
          method: payment.method,
          displayNumber: payment.displayNumber,
          hasProof: Boolean(proofFile),
        },
        ip: ctx.req.headers.get("x-forwarded-for"),
        userAgent: ctx.req.headers.get("user-agent") ?? undefined,
      },
      tx
    );

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "PAYMENT_SUBMITTED",
        title: "New payment submitted",
        message: `${residentName} submitted a payment of ${formatMinor(payment.amountMinor)} (${payment.displayNumber}) for review.`,
        entityRef: payment.id,
      },
      tx
    );

    return { replay: false as const, payload };
  });

  await sweepOutboxSafe();

  return {
    data: result.payload,
    meta: result.replay ? { idempotentReplay: true } : undefined,
  };
});

// ---------------------------------------------------------------------------
// GET — own payments
// ---------------------------------------------------------------------------
export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const month = url.searchParams.get("month") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  if (status && !["PENDING", "APPROVED", "REJECTED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(status)) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Unknown payment status filter.", 400);
  }

  let monthYear: { year: number; month: number } | null = null;
  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Months use the YYYY-MM format.", 400);
    } else {
      monthYear = { year: Number(m[1]), month: Number(m[2]) };
    }
  }

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = monthYear ? periodBounds(monthYear.year, monthYear.month, tz) : currentPeriodBounds(tz);

  const base: Record<string, unknown> = { residentId: ctx.user.id, institutionId: ctx.institutionId };
  if (status) base.status = status;
  if (monthYear) {
    base.submittedAt = { gte: bounds.startInstant, lt: bounds.endInstant };
  }

  const { where, take } = keysetWhere(base, "submittedAt", cursor, limit);
  const rows = await db.payment.findMany({ where, orderBy: [{ submittedAt: "desc" }, { id: "desc" }], take });
  const page = finishPage(rows, limit, (row) => row.submittedAt);

  const [depositsAgg, pendingCount, refundPendingCount, refundsThisMonthAgg, funds] = await Promise.all([
    db.payment.aggregate({
      _sum: { amountMinor: true },
      where: {
        residentId: ctx.user.id,
        institutionId: ctx.institutionId,
        status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },
        submittedAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    db.payment.count({ where: { residentId: ctx.user.id, institutionId: ctx.institutionId, status: "PENDING" } }),
    db.refund.count({ where: { residentId: ctx.user.id, status: { in: ["PENDING", "PROCESSING"] } } }),
    db.refund.aggregate({
      _sum: { amountMinor: true },
      where: {
        residentId: ctx.user.id,
        institutionId: ctx.institutionId,
        status: "COMPLETED",
        createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
      },
    }),
    residentFundsSummary(ctx.user.id),
  ]);

  return {
    data: page.items.map((p) => serializePayment(p)),
    meta: {
      nextCursor: page.nextCursor,
      month: month ?? bounds.periodKey,
      depositsThisMonth: depositsAgg._sum.amountMinor ?? 0,
      depositsThisMonthFormatted: formatMinor(depositsAgg._sum.amountMinor ?? 0),
      totalDepositsAllTime: funds.creditsMinor,
      totalDepositsAllTimeFormatted: formatMinor(funds.creditsMinor),
      totalAvailableMinor: funds.availableMinor,
      totalAvailableFormatted: formatMinor(funds.availableMinor),
      policyState: funds.policyState,
      pendingCount,
      refundPendingCount,
      refundsThisMonth: refundsThisMonthAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(refundsThisMonthAgg._sum.amountMinor ?? 0),
    },
  };
});
