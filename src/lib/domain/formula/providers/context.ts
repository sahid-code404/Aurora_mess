/**
 * CONTEXT VARIABLE PROVIDER (spec §16)
 * Resolves calendar and period metadata.
 */
import { PeriodBounds } from "../period-variables";

export function resolveContextVariables(
  bounds: PeriodBounds,
  gracePeriodDays = 7
): Record<string, number> {
  const daysInMonth = new Date(Date.UTC(bounds.year, bounds.month, 0)).getUTCDate();

  return {
    billing_period_days: daysInMonth,
    days_in_month: daysInMonth,
    selected_year: bounds.year,
    selected_month: bounds.month,
    grace_period_days: gracePeriodDays,
  };
}
