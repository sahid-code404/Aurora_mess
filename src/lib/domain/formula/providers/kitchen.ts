/**
 * KITCHEN SERVING VARIABLE PROVIDER (spec §10)
 * total_servings = total_resident_meals + total_guest_meals
 */
export function resolveKitchenVariables(
  residentMeals: number,
  guestMeals: number
): Record<string, number> {
  return {
    total_servings: residentMeals + guestMeals,
  };
}
