/**
 * /api/v1/admin/refunds (auth ADMIN)
 *
 * POST — issue a refund / resolve excess credit (spec §43).
 *   { residentId, amount (decimal string), mode: CARRY_FORWARD | ISSUE_REFUND,
 *     reason, paymentId?, destination? }
 *   Guard: amount must fit within availableMinor (APPROVED funds only —
 *     refunding against PENDING payments pays out money the institution has
 *     not received yet; audit 9-c finding #1). INSUFFICIENT_REFUND_CREDIT
 *     carries the actual creditable amount.
 *
 *   MODE SEMANTICS:
 *   - ISSUE_REFUND: cash actually leaves the books in one balanced journal
 *     (Dr RESIDENT_FUNDS / Cr CASH) — no dangling REFUND_PAYABLE (audit 9-c
 *     finding #3: the previous Dr FUNDS/Cr PAYABLE posting was never settled,
 *     overstating CASH). Refund row status COMPLETED; funds kernel subtracts
 *     refundsIssuedMinor from available — truthful (money paid out).
 *   - CARRY_FORWARD: no journal; the credit STAYS available for future bills
 *     (the funds kernel does not subtract carry-forward — audit 9-c finding #2:
 *     subtracting erased money the resident had actually paid). The refund row
 *     records that the excess was acknowledged/resolved with the resident.
 *
 *   Concurrency: after the write, availableMinor is re-verified ≥ 0 inside the
 *   same transaction — a concurrent over-refund rolls back (SQLite serializes
 *   writers, so the second transaction re-reads post-commit state).
 *
 * GET — refund list with resident names (keyset cursor).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox, sweepOutbox } from "@/lib/outbox";
import { formatMinor, parseDecimalToMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { reasonSchema } from "@/lib/validation";
import { postJournal } from "@/lib/domain/ledger";
import { residentFundsSummary } from "@/lib/domain/funds";
import { finishPage, keysetWhere } from "@/lib/domain/http";
import { serializeRefund } from "@/lib/domain/serialize";
import { currentPeriodBounds } from "@/lib/domain/formula/period-variables";

export const dynamic = "force-dynamic";

const MAX_REFUND_MINOR = 100_000_000;

const bodySchema = z.object({
  residentId: z.string().min(5, "Choose a resident."),
  amount: z.string().min(1, "Enter a refund amount."),
  mode: z.enum(["CARRY_FORWARD", "ISSUE_REFUND"]),
  reason: reasonSchema,
  paymentId: z.string().optional(),
  destination: z.string().max(120, "Keep the destination under 120 characters.").optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);

  const amountMinor = parseDecimalToMinor(body.amount);
  if (amountMinor === null || amountMinor <= 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Enter a valid refund amount greater than zero.", 400, {
      amount: "Enter a valid refund amount greater than zero.",
    });
  }
  if (amountMinor > MAX_REFUND_MINOR) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Refunds up to ₹10,00,000.00 are supported.", 400, {
      amount: "Refunds up to ₹10,00,000.00 are supported.",
    });
  }

  const resident = await db.user.findFirst({
    where: { id: body.residentId, institutionId: ctx.institutionId, role: "RESIDENT" },
    select: { id: true, status: true, institutionId: true },
  });
  if (!resident) throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);

  const profile = await db.userProfile.findUnique({ where: { userId: resident.id }, select: { fullName: true } });
  const residentName = profile?.fullName ?? "Resident";

  if (body.paymentId) {
    const payment = await db.payment.findFirst({
      where: { id: body.paymentId, institutionId: ctx.institutionId, residentId: resident.id },
      select: { id: true },
    });
    if (!payment) {
      throw new ApiError(CODES.VALIDATION_FAILED, "The linked payment does not belong to this resident.", 400, {
        paymentId: "The linked payment does not belong to this resident.",
      });
    }
  }

  await getInstitution(ctx.institutionId); // pre-warm the settings cache for the tx below

  const refund = await db.$transaction(async (tx) => {
    const summary = await residentFundsSummary(resident.id, tx);
    // Refundable credit = APPROVED funds only. PENDING payments are not money
    // yet (they can still be rejected) — refunding against them pays out cash
    // the institution never received (audit 9-c finding #1).
    const creditable = summary.availableMinor;
    if (amountMinor > creditable) {
      throw new ApiError(
        CODES.INSUFFICIENT_REFUND_CREDIT,
        `This resident only has ${formatMinor(Math.max(0, creditable))} available to refund.`,
        422
      );
    }

    let journalId: string | null = null;
    if (body.mode === "ISSUE_REFUND") {
      // Cash-out in ONE balanced journal: the resident's fund is debited and
      // cash is credited — the money genuinely leaves the books.
      const journal = await postJournal(
        {
          institutionId: ctx.institutionId,
          refType: "REFUND",
          refId: body.paymentId ?? undefined,
          description: `Refund to ${residentName} (${body.reason})`,
          createdByUserId: ctx.user.id,
          lines: [
            { accountCode: "RESIDENT_FUNDS", debitMinor: amountMinor },
            { accountCode: "CASH", creditMinor: amountMinor },
          ],
        },
        tx
      );
      journalId = journal.journalId;
    }

    const created = await tx.refund.create({
      data: {
        institutionId: ctx.institutionId,
        residentId: resident.id,
        paymentId: body.paymentId ?? null,
        amountMinor,
        mode: body.mode,
        reason: body.reason,
        destination: body.destination ?? null,
        status: "COMPLETED",
        journalId,
        createdByUserId: ctx.user.id,
        completedAt: new Date(),
      },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "REFUND_ISSUED",
        entityType: "REFUND",
        entityId: created.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: "—",
        afterSummary: body.mode,
        metadata: {
          amountMinor,
          mode: body.mode,
          residentId: resident.id,
          journalId,
        },
      },
      tx
    );

    await appendOutbox(
      ctx.institutionId,
      "NOTIFICATION",
      {
        userId: resident.id,
        institutionId: ctx.institutionId,
        type: "REFUND_ISSUED",
        title: body.mode === "ISSUE_REFUND" ? "Refund issued" : "Excess credit noted",
        message:
          body.mode === "ISSUE_REFUND"
            ? `A refund of ${formatMinor(amountMinor)} has been issued for you — ${body.reason}`
            : `An excess credit of ${formatMinor(amountMinor)} was noted on your account — it stays available for future bills.`,
        entityRef: created.id,
      },
      tx
    );

    // Post-condition (concurrency guard): with the refund row + journal in
    // place, the resident must still not be overdrawn — a racing refund that
    // double-spent the same credit rolls back here.
    const postSummary = await residentFundsSummary(resident.id, tx);
    if (postSummary.availableMinor < 0) {
      throw new ApiError(
        CODES.INSUFFICIENT_REFUND_CREDIT,
        `This resident only has ${formatMinor(Math.max(0, summary.availableMinor))} available to refund.`,
        422
      );
    }

    return created;
  });

  sweepOutbox(20).catch(() => {});

  // Fresh post-commit summary (provenance for the resulting balances).
  const summaryAfter = await residentFundsSummary(resident.id);

  return {
    data: {
      refund: serializeRefund(refund),
      residentSummary: {
        ...summaryAfter,
        availableFormatted: formatMinor(summaryAfter.availableMinor),
        creditsFormatted: formatMinor(summaryAfter.creditsMinor),
        amountToPayFormatted: formatMinor(summaryAfter.amountToPayMinor),
      },
    },
  };
});

// ---------------------------------------------------------------------------
// GET — refund list
// ---------------------------------------------------------------------------
export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const residentId = url.searchParams.get("residentId") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
  const baseWhere: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (residentId) baseWhere.residentId = residentId;

  const { where, take } = keysetWhere(baseWhere, "createdAt", cursor, limit);
  const rows = await db.refund.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
  const page = finishPage(rows, limit, (row) => row.createdAt);

  const residentIds = [...new Set(page.items.map((r) => r.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({ where: { userId: { in: residentIds } }, select: { userId: true, fullName: true } })
    : [];
  const nameMap = new Map(profiles.map((p) => [p.userId, p.fullName]));

  const inst = await getInstitution(ctx.institutionId);
  const bounds = currentPeriodBounds(inst?.timezone ?? "UTC");
  const thisMonthAgg = await db.refund.aggregate({
    _sum: { amountMinor: true },
    where: {
      institutionId: ctx.institutionId,
      status: "COMPLETED",
      createdAt: { gte: bounds.startInstant, lt: bounds.endInstant },
    },
  });

  const sortedItems = [...page.items].sort((a, b) => {
    const getRank = (st: string) => {
      if (st === "PENDING" || st === "PROCESSING") return 0;
      return 1;
    };
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return {
    data: sortedItems.map((r) => ({
      ...serializeRefund(r),
      residentName: nameMap.get(r.residentId) ?? "Resident",
    })),
    meta: {
      nextCursor: page.nextCursor,
      refundsThisMonth: thisMonthAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(thisMonthAgg._sum.amountMinor ?? 0),
    },
  };
});
