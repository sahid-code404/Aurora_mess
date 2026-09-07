/**
 * GET /api/v1/admin/refunds/eligible — post-billing overpayment queue.
 *
 * A resident appears only after at least one authoritative bill is generated,
 * all current charges/refunds are accounted for, and positive excess credit
 * remains unresolved for the latest bill cycle. Historical/departed residents
 * remain eligible: deactivation must never strand money owed back to them.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatMinor } from "@/lib/money";
import { refundEligibilityForResident } from "@/lib/domain/refunds";

export const dynamic = "force-dynamic";

const RESIDENT_BATCH_SIZE = 100;

type RefundQueueResident = {
  id: string;
  email: string;
  profile: { fullName: string; roomNumber: string | null } | null;
};

type RefundQueueRow = {
  resident: RefundQueueResident;
  eligibility: Awaited<ReturnType<typeof refundEligibilityForResident>>;
};

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  const residentWhere = {
    institutionId: ctx.institutionId,
    role: "RESIDENT",
    // ACTIVE is the normal case. INACTIVE/PENDING_DELETION remain here
    // because historical bills and excess credit survive account lifecycle
    // changes. Pre-approval/rejected accounts cannot have legitimate bills.
    status: { in: ["ACTIVE", "INACTIVE", "PENDING_DELETION"] },
    ...(q
      ? {
          OR: [
            { email: { contains: q } },
            { profile: { fullName: { contains: q } } },
            { profile: { roomNumber: { contains: q } } },
          ],
        }
      : {}),
  };

  // Never cap money owed to residents because of a UI safety limit. Walk the
  // entire population in stable keyset batches while keeping eligibility fan-out
  // bounded to RESIDENT_BATCH_SIZE at any one time.
  const eligibility: RefundQueueRow[] = [];
  let cursorId: string | undefined;

  while (true) {
    const residents = await db.user.findMany({
      where: residentWhere,
      select: {
        id: true,
        email: true,
        profile: { select: { fullName: true, roomNumber: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: RESIDENT_BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    if (residents.length === 0) break;

    const batch = await Promise.all(
      residents.map(async (resident) => ({
        resident,
        eligibility: await refundEligibilityForResident(resident.id),
      }))
    );
    eligibility.push(...batch);

    if (residents.length < RESIDENT_BATCH_SIZE) break;
    cursorId = residents[residents.length - 1]?.id;
    if (!cursorId) break;
  }

  const generatedBillRows = eligibility.filter((row) => row.eligibility.latestBill);
  const candidates = eligibility
    .filter((row) => row.eligibility.eligible)
    .map(({ resident, eligibility: item }) => ({
      residentId: resident.id,
      residentName: resident.profile?.fullName ?? "Resident",
      roomNumber: resident.profile?.roomNumber ?? null,
      email: resident.email,
      refundableMinor: item.refundableMinor,
      refundableFormatted: formatMinor(item.refundableMinor),
      creditsMinor: item.summary.creditsMinor,
      creditsFormatted: formatMinor(item.summary.creditsMinor),
      chargesMinor: item.summary.chargesMinor,
      chargesFormatted: formatMinor(item.summary.chargesMinor),
      refundsIssuedMinor: item.summary.refundsIssuedMinor,
      refundsIssuedFormatted: formatMinor(item.summary.refundsIssuedMinor),
      latestBill: item.latestBill
        ? {
            id: item.latestBill.id,
            billNumber: item.latestBill.billNumber,
            billingPeriodId: item.latestBill.billingPeriodId,
            year: item.latestBill.year,
            month: item.latestBill.month,
            generatedAt: item.latestBill.generatedAt.toISOString(),
          }
        : null,
    }))
    .sort((a, b) => b.refundableMinor - a.refundableMinor || a.residentName.localeCompare(b.residentName));

  const totalRefundableMinor = candidates.reduce((sum, candidate) => sum + candidate.refundableMinor, 0);
  const latestBillGeneratedAt = generatedBillRows.reduce<Date | null>((latest, row) => {
    const generatedAt = row.eligibility.latestBill?.generatedAt ?? null;
    return generatedAt && (!latest || generatedAt > latest) ? generatedAt : latest;
  }, null);

  return {
    data: candidates,
    meta: {
      candidateCount: candidates.length,
      totalRefundableMinor,
      totalRefundableFormatted: formatMinor(totalRefundableMinor),
      hasGeneratedBills: generatedBillRows.length > 0,
      latestBillGeneratedAt: latestBillGeneratedAt?.toISOString() ?? null,
      carriedForwardCount: eligibility.filter((row) => row.eligibility.reason === "CARRIED_FORWARD").length,
      scannedResidentCount: eligibility.length,
    },
  };
});
