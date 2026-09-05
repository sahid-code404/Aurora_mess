import { dateKeyInTz, localDateMidnightUtc } from "@/lib/time";

export type BillStatusInput = {
  status: string;
  dueDate: Date;
  totalDueMinor: number;
  paymentsMinor: number;
};

/**
 * Bill due dates are stored as UTC-midnight calendar markers, not true UTC
 * deadline instants. Convert "today" in the institution timezone to the same
 * marker representation before comparing them.
 *
 * A bill due on 2026-09-05 remains due for the whole local calendar day and
 * becomes overdue only when the institution reaches 2026-09-06.
 */
export function currentLocalDateMarker(timeZone: string, now = new Date()): Date {
  return localDateMidnightUtc(dateKeyInTz(now, timeZone));
}

export function isBillPastDueDate(dueDate: Date, timeZone: string, now = new Date()): boolean {
  return dueDate.getTime() < currentLocalDateMarker(timeZone, now).getTime();
}

/**
 * Derive the user-facing/current bill state from immutable financial facts.
 * This intentionally does not trust a previously persisted OVERDUE value,
 * because older code compared a date marker directly with wall-clock UTC time
 * and could mark a bill overdue hours too early in non-UTC institutions.
 */
export function effectiveBillStatus(
  bill: BillStatusInput,
  timeZone: string,
  now = new Date()
): "GENERATED" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "VOIDED" {
  if (bill.status === "VOIDED") return "VOIDED";
  if (bill.totalDueMinor <= 0) return "PAID";
  if (isBillPastDueDate(bill.dueDate, timeZone, now)) return "OVERDUE";
  return bill.paymentsMinor > 0 ? "PARTIALLY_PAID" : "GENERATED";
}
