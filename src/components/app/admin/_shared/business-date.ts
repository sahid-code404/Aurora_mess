"use client";

/**
 * Business-date helpers for Admin screens.
 *
 * Server financial/reporting routes resolve periods in the institution timezone,
 * so client month/date defaults must use the same timezone instead of the
 * browser's local clock. This matters around midnight and for admins travelling
 * outside the institution's timezone.
 */
function browserLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dateKeyInTz(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = value("year");
    const month = value("month");
    const day = value("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid/missing deployment timezone: preserve a usable local fallback.
  }
  return browserLocalDateKey(date);
}

export function todayKeyInTz(timezone: string, now = new Date()): string {
  return dateKeyInTz(now, timezone);
}

export function currentMonthKeyInTz(timezone: string, now = new Date()): string {
  return todayKeyInTz(timezone, now).slice(0, 7);
}
