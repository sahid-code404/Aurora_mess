/**
 * /api/v1/admin/refunds (auth ADMIN)
 *
 * POST — issue a refund / resolve excess credit.
 * The financial mutation lives in the refund domain service. It serializes
 * resident financial mutations with the resident mutex before re-reading
 * eligibility and posts ISSUE_REFUND journals against the refund ID itself.
 *
 * GET — searchable refund list with resident names (keyset cursor).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { sweepOutbox } from "@/lib/outbox";
import { formatMinor, parseDecimalToMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { reasonSchema } from "@/lib/validation";
import { residentFundsSummary } from "@/lib/domain/funds";
import { createRefund } from "@/lib/domain/refunds";
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

  const refund = await createRefund({
    institutionId: ctx.institutionId,
    residentId: body.residentId,
    amountMinor,
    mode: body.mode,
    reason: body.reason,
    paymentId: body.paymentId ?? null,
    destination: body.destination ?? null,
    actorUserId: ctx.user.id,
    requestId: ctx.requestId,
  });

  sweepOutbox(20).catch(() => {});

  // Fresh post-commit summary: this is a read model for the response, not part
  // of the financial transaction's correctness boundary.
  const summaryAfter = await residentFundsSummary(refund.residentId);

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
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
  const baseWhere: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (residentId) baseWhere.residentId = residentId;

  let searchConditions: Record<string, unknown>[] | null = null;
  if (q) {
    // Refund rows intentionally store residentId only. Resolve the visible
    // resident identity first, then combine it with refund-native text fields.
    const matchedResidents = await db.user.findMany({
      where: {
        institutionId: ctx.institutionId,
        role: "RESIDENT",
        OR: [
          { email: { contains: q } },
          { profile: { fullName: { contains: q } } },
          { profile: { roomNumber: { contains: q } } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    searchConditions = [
      { residentId: { in: matchedResidents.map((resident) => resident.id) } },
      { reason: { contains: q } },
      { destination: { contains: q } },
    ];
  }

  const { where, take } = keysetWhere(baseWhere, "createdAt", cursor, limit);
  if (searchConditions) {
    where.AND = [...((where.AND as Record<string, unknown>[]) ?? []), { OR: searchConditions }];
  }
  const rows = await db.refund.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
  const page = finishPage(rows, limit, (row) => row.createdAt);

  const residentIds = [...new Set(page.items.map((refund) => refund.residentId))];
  const profiles = residentIds.length
    ? await db.userProfile.findMany({ where: { userId: { in: residentIds } }, select: { userId: true, fullName: true } })
    : [];
  const nameMap = new Map(profiles.map((profile) => [profile.userId, profile.fullName]));

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
    const getRank = (status: string) => (status === "PENDING" || status === "PROCESSING" ? 0 : 1);
    const rankA = getRank(a.status);
    const rankB = getRank(b.status);
    if (rankA !== rankB) return rankA - rankB;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return {
    data: sortedItems.map((refund) => ({
      ...serializeRefund(refund),
      residentName: nameMap.get(refund.residentId) ?? "Resident",
    })),
    meta: {
      nextCursor: page.nextCursor,
      refundsThisMonth: thisMonthAgg._sum.amountMinor ?? 0,
      refundsThisMonthFormatted: formatMinor(thisMonthAgg._sum.amountMinor ?? 0),
    },
  };
});
