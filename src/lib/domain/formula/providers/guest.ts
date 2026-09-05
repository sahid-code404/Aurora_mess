/**
 * GUEST MEAL VARIABLE PROVIDER (spec §6, §9)
 * Guest meals must remain completely separate from regular Resident meal count.
 * Booked guest money is historical input: use each row's frozen totalPriceMinor,
 * never recompute old bookings from today's institution guest price.
 */
import { PeriodBounds } from "../period-variables";

export async function resolveGuestVariables(
  institutionId: string,
  bounds: PeriodBounds,
  residentId: string | undefined,
  client: any
): Promise<Record<string, number>> {
  const serviceDateRange = { gte: bounds.startAt, lt: bounds.endExclusiveAt };
  const guestStatuses = ["CONFIRMED", "LOCKED", "CONSUMED"];

  const [guestAgg, settings, residentGuestAgg] = await Promise.all([
    client.guestMealRequest.aggregate({
      _sum: { totalPriceMinor: true, quantity: true },
      where: {
        institutionId,
        status: { in: guestStatuses },
        mealInstance: { serviceDate: serviceDateRange },
      },
    }),
    client.institutionSettings.findUnique({
      where: { institutionId },
      select: { guestMealPriceMinor: true },
    }),
    residentId
      ? client.guestMealRequest.aggregate({
          _sum: { totalPriceMinor: true, quantity: true },
          where: {
            institutionId,
            hostResidentId: residentId,
            status: { in: guestStatuses },
            mealInstance: { serviceDate: serviceDateRange },
          },
        })
      : Promise.resolve(null),
  ]);

  const guestMeals = guestAgg._sum.quantity ?? 0;
  const guestPrice = settings?.guestMealPriceMinor ?? 5500;
  const guestIncome = guestAgg._sum.totalPriceMinor ?? 0;
  const resGuestMeals = residentGuestAgg?._sum.quantity ?? guestMeals;
  const resGuestIncome = residentGuestAgg?._sum.totalPriceMinor ?? guestIncome;

  return {
    total_guest_meals: guestMeals,
    guest_meal_price: guestPrice,
    total_guest_income: guestIncome,
    resident_guest_meals: resGuestMeals,
    guest_income_for_resident: resGuestIncome,
  };
}
