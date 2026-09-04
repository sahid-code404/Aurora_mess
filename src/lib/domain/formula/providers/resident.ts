/**
 * RESIDENT VARIABLE PROVIDER (spec §6, §7)
 * Resolves resident counts according to membership dates and statuses.
 */
import { PeriodBounds } from "../period-variables";

export async function resolveResidentVariables(
  institutionId: string,
  bounds: PeriodBounds,
  client: any
): Promise<Record<string, number>> {
  // Membership effective date filtering for the period
  const [totalResidents, activeResidents, inactiveResidents, joinedResidents] = await Promise.all([
    client.user.count({
      where: {
        institutionId,
        role: "RESIDENT",
        status: { in: ["ACTIVE", "INACTIVE"] },
        OR: [
          { membershipEffectiveFrom: null },
          { membershipEffectiveFrom: { lt: bounds.endExclusiveAt } },
        ],
        AND: [
          {
            OR: [
              { membershipEffectiveUntil: null },
              { membershipEffectiveUntil: { gte: bounds.startAt } },
            ],
          },
        ],
      },
    }),
    client.user.count({
      where: {
        institutionId,
        role: "RESIDENT",
        status: "ACTIVE",
      },
    }),
    client.user.count({
      where: {
        institutionId,
        role: "RESIDENT",
        status: "INACTIVE",
      },
    }),
    client.user.count({
      where: {
        institutionId,
        role: "RESIDENT",
        membershipEffectiveFrom: { gte: bounds.startAt, lt: bounds.endExclusiveAt },
      },
    }),
  ]);

  return {
    total_residents: totalResidents,
    total_active_residents: activeResidents,
    total_inactive_residents: inactiveResidents,
    resident_joined_count: joinedResidents,
    resident_count: totalResidents,
  };
}
