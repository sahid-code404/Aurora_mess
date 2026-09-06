import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";
import { zonedTimeToUtc } from "@/lib/time";

export type MembershipWindow = {
  membershipEffectiveFrom: Date | null;
  membershipEffectiveUntil: Date | null;
};

type BoundaryKind = "FROM" | "UNTIL";
type BoundaryPosition = "BEFORE" | "INSIDE" | "AFTER";

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

function boundaryPosition(
  value: Date | null,
  kind: BoundaryKind,
  startAt: Date,
  endExclusiveAt: Date
): BoundaryPosition {
  // A missing start means membership existed before the modeled history; a
  // missing end means it continues after the modeled history.
  if (value === null) return kind === "FROM" ? "BEFORE" : "AFTER";
  if (value.getTime() < startAt.getTime()) return "BEFORE";
  if (value.getTime() >= endExclusiveAt.getTime()) return "AFTER";
  return "INSIDE";
}

/**
 * Whether changing one membership boundary can alter any fact inside a closed
 * billing period. Moving a boundary while both old/new values remain entirely
 * before the period or entirely after it is harmless for that period. Any
 * crossing, or any change within the period itself, is history-changing.
 */
export function membershipBoundaryChangeTouchesPeriod(
  before: Date | null,
  after: Date | null,
  kind: BoundaryKind,
  startAt: Date,
  endExclusiveAt: Date
): boolean {
  if (sameInstant(before, after)) return false;
  const beforePosition = boundaryPosition(before, kind, startAt, endExclusiveAt);
  const afterPosition = boundaryPosition(after, kind, startAt, endExclusiveAt);
  if (beforePosition !== afterPosition) return true;
  return beforePosition === "INSIDE";
}

/**
 * Closed billing periods are immutable financial history. Membership dates
 * feed resident counts, meal eligibility and formula inputs, so neither the
 * start nor end boundary may be moved in a way that changes a BILLED period.
 * Reopening that period is the explicit workflow for corrections.
 *
 * Callers must hold the Institution financial mutex before this check so bill
 * generation/reopen cannot change period state concurrently.
 */
export async function assertMembershipWindowPreservesBilledHistory(
  client: Prisma.TransactionClient,
  institutionId: string,
  timezone: string,
  before: MembershipWindow,
  after: MembershipWindow
): Promise<void> {
  const periods = await client.billingPeriod.findMany({
    where: { institutionId, status: "BILLED" },
    select: { year: true, month: true },
  });

  for (const period of periods) {
    const startAt = zonedTimeToUtc(period.year, period.month, 1, 0, 0, timezone);
    const nextYear = period.month === 12 ? period.year + 1 : period.year;
    const nextMonth = period.month === 12 ? 1 : period.month + 1;
    const endExclusiveAt = zonedTimeToUtc(nextYear, nextMonth, 1, 0, 0, timezone);

    const changesStart = membershipBoundaryChangeTouchesPeriod(
      before.membershipEffectiveFrom,
      after.membershipEffectiveFrom,
      "FROM",
      startAt,
      endExclusiveAt
    );
    const changesEnd = membershipBoundaryChangeTouchesPeriod(
      before.membershipEffectiveUntil,
      after.membershipEffectiveUntil,
      "UNTIL",
      startAt,
      endExclusiveAt
    );

    if (changesStart || changesEnd) {
      throw new ApiError(
        CODES.BILLING_PERIOD_CLOSED,
        `Membership dates affect the billed period ${period.year}-${String(period.month).padStart(2, "0")}. Reopen that billing period before changing historical membership.`,
        409
      );
    }
  }
}
