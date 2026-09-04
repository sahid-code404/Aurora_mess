/**
 * MEAL VARIABLE PROVIDER (spec §6, §8)
 *
 * CRITICAL RULE (spec §8):
 * total_resident_meals is the SUM of regular Resident meals only.
 * Guest meals are completely excluded!
 */
import { PeriodBounds } from "../period-variables";

export async function resolveMealVariables(
  institutionId: string,
  bounds: PeriodBounds,
  residentId: string | undefined,
  client: any
): Promise<Record<string, number>> {
  const serviceDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };
  const now = new Date();

  // Spec §8 & Cutoff Rule:
  // Count only confirmed regular Resident meals:
  // 1. Locked (lockedAt is not null)
  // 2. OR Admin Override (adminOverrideState is ON)
  // 3. OR Cutoff has already passed (cutoffAt <= now)
  // 4. OR Meal instance is LOCKED, SERVICE_ACTIVE, or COMPLETED
  // Unconfirmed future/open meals before cutoff are completely excluded.
  const confirmedOnFilter = {
    institutionId,
    effectiveState: "ON",
    mealInstance: { serviceDate: serviceDateRange },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "ON" },
      { mealInstance: { cutoffAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };

  const confirmedOffFilter = {
    institutionId,
    effectiveState: "OFF",
    mealInstance: { serviceDate: serviceDateRange },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "OFF" },
      { mealInstance: { cutoffAt: { lte: now } } },
      { mealInstance: { status: { in: ["LOCKED", "SERVICE_ACTIVE", "COMPLETED"] } } },
    ],
  };

  const [totalOn, totalOff, totalLocked, residentOn] = await Promise.all([
    client.residentMeal.count({
      where: confirmedOnFilter,
    }),
    client.residentMeal.count({
      where: confirmedOffFilter,
    }),
    client.residentMeal.count({
      where: {
        institutionId,
        effectiveState: "ON",
        lockedAt: { not: null },
        mealInstance: { serviceDate: serviceDateRange },
      },
    }),
    residentId
      ? client.residentMeal.count({
          where: {
            ...confirmedOnFilter,
            residentId,
          },
        })
      : Promise.resolve(null),
  ]);

  const residentMealCount = residentOn ?? totalOn;

  return {
    total_resident_meals: totalOn,
    total_resident_meals_on: totalOn,
    total_resident_meals_off: totalOff,
    total_locked_resident_meals: totalLocked,
    resident_meal_count: residentMealCount,
    // Legacy alias
    total_consumed_resident_meals: totalOn,
  };
}
