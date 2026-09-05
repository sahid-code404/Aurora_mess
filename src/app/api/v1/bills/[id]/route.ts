/**
 * GET /api/v1/bills/[id] — ONE bill, mine only (auth RESIDENT; ownership
 * enforced — another resident's bill id is FORBIDDEN). Includes lines with
 * their calculation provenance (detail JSON: dates covered, formula text,
 * payment ids), adjustments, the period, and the snapshot reference
 * (checksum + frozen per-meal charge) — spec §58 "View calculation".
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { serializeBill, serializeBillLine } from "@/lib/domain/serialize";
import { effectiveBillStatus } from "@/lib/domain/bill-status";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const bill = await db.bill.findUnique({
    where: { id: ctx.params.id },
    include: {
      period: { select: { id: true, year: true, month: true, status: true } },
      lines: { orderBy: { sortOrder: "asc" } },
      adjustments: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!bill || bill.institutionId !== ctx.institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Bill not found.", 404);
  }
  // Ownership: residents see their own bills only (spec §217).
  if (bill.residentId !== ctx.user.id) {
    throw new ApiError(CODES.FORBIDDEN, "You do not have access to this bill.", 403);
  }

  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const now = new Date();

  const snapshot = await db.billingSnapshot.findUnique({
    where: { billingPeriodId: bill.billingPeriodId },
    select: { id: true, checksum: true, mealChargeMinor: true, createdAt: true },
  });

  return {
    data: {
      ...serializeBill(bill),
      status: effectiveBillStatus(bill, timeZone, now),
      lines: bill.lines.map((line) => serializeBillLine(line)),
      adjustments: bill.adjustments.map((a) => ({
        id: a.id,
        amountMinor: a.amountMinor,
        amountFormatted: formatMinor(a.amountMinor),
        reason: a.reason,
        createdAt: a.createdAt.toISOString(),
      })),
      snapshot: snapshot
        ? {
            id: snapshot.id,
            checksum: snapshot.checksum,
            mealChargeMinor: snapshot.mealChargeMinor,
            mealChargeFormatted: formatMinor(snapshot.mealChargeMinor),
            createdAt: snapshot.createdAt.toISOString(),
          }
        : null,
    },
  };
});
