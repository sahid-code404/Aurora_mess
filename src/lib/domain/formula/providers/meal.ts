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

  // Match billing's authoritative confirmation kernel exactly:
  // 1. Persisted locked row
  // 2. OR explicit Admin override
  // 3. OR authoritative lockAt has passed
  // 4. OR instance lifecycle is already locked/service-active/completed
  const confirmedOnFilter = {
    institutionId,
    effectiveState: "ON",
    mealInstance: { serviceDate: serviceDateRange },
    OR: [
      { lockedAt: { not: null } },
      { adminOverrideState: "ON" },
      { mealInstance: { lockAt: { lte: now } } },
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
      { mealInstance: { lockAt: { lte: now } } },
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
