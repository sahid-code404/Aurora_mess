/**
 * TIME — server time is authoritative (spec §15-16). Institution timezone
 * drives cutoffs/billing boundaries. No external tz library: Intl only.
 */

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

/** Wall-clock parts of an instant, in a timezone. */
export function partsInTz(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
  };
}

/** "YYYY-MM-DD" of an instant in a timezone. */
export function dateKeyInTz(date: Date, timeZone: string): string {
  const p = partsInTz(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Convert local wall time in a timezone to a UTC instant.
 * Uses the standard two-pass offset technique — no external deps.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const first = partsInTz(new Date(guess), timeZone);
  const asUTC = Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute);
  const offset = asUTC - guess;
  return new Date(guess - offset);
}

/** Midnight (00:00) UTC instant marker for a local calendar date — canonical serviceDate storage. */
export function localDateMidnightUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/** Parse "HH:MM" → {hour, minute}. */
export function parseLocalTime(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return { hour: 12, minute: 0 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

/** Compute the absolute cutoff instant for a service date + cutoff config. */
export function computeCutoffAt(
  serviceDateKey: string,
  cutoffLocalTime: string,
  offsetDays: number,
  timeZone: string
): Date {
  const [y, m, d] = serviceDateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d - offsetDays, 0, 0, 0, 0));
  const shiftedKey = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate()
  ).padStart(2, "0")}`;
  const { hour, minute } = parseLocalTime(cutoffLocalTime);
  const [sy, sm, sd] = shiftedKey.split("-").map(Number);
  return zonedTimeToUtc(sy, sm, sd, hour, minute, timeZone);
}

/** Service window start/end instants for a service date. */
export function computeServiceWindow(
  serviceDateKey: string,
  startLocal: string,
  endLocal: string,
  timeZone: string
): { startAt: Date; endAt: Date } {
  const [y, m, d] = serviceDateKey.split("-").map(Number);
  const s = parseLocalTime(startLocal);
  const e = parseLocalTime(endLocal);
  return {
    startAt: zonedTimeToUtc(y, m, d, s.hour, s.minute, timeZone),
    endAt: zonedTimeToUtc(y, m, d, e.hour, e.minute, timeZone),
  };
}

/** Add days to a "YYYY-MM-DD" key (returns new key). */
export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 0, 0, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Month boundaries in a timezone: returns {year, month, startKey, endKey} for an instant. */
export function monthBoundsInTz(date: Date, timeZone: string) {
  const p = partsInTz(date, timeZone);
  const startKey = `${p.year}-${String(p.month).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(p.year, p.month, 0)); // day 0 of next month = last day
  const endKey = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
  return { year: p.year, month: p.month, startKey, endKey };
}

/** Friendly date label: "2 Sep 2026". */
export function formatDateLabel(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/** Friendly time label in institution tz: "8:42 PM". */
export function formatTimeLabel(date: Date | string, timeZone: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

/** Weekday of a date key: 1=Mon..7=Sun. */
export function weekdayOfKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return jsDay === 0 ? 7 : jsDay;
}

export function greetingFor(hour: number): { text: string; icon: string } {
  if (hour < 5) return { text: "Good Night", icon: "🌙" };
  if (hour < 12) return { text: "Good Morning", icon: "☀️" };
  if (hour < 17) return { text: "Good Afternoon", icon: "🌤️" };
  if (hour < 21) return { text: "Good Evening", icon: "🌆" };
  return { text: "Good Evening", icon: "🌙" };
}
