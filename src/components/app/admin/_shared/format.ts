"use client";

/**
 * Client-safe formatting helpers for the admin views.
 * Mirrors lib/money.ts formatting (₹, en-IN, 2 decimals) without server imports.
 */

const MINOR_DIGITS = 2;
const MINOR_FACTOR = 10 ** MINOR_DIGITS;

/** Integer minor units → "₹1,23,456.78" (or "−₹…" for negatives). */
export function fmtMinor(minor: number | null | undefined, withSign = false): string {
  if (minor == null || !Number.isFinite(minor)) return "—";
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_FACTOR);
  const frac = String(abs % MINOR_FACTOR).padStart(MINOR_DIGITS, "0");
  const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(whole);
  const sign = neg ? "−" : withSign ? "+" : "";
  return `${sign}₹${grouped}.${frac}`;
}

/** "48.71" from 4871 (compact per-meal labels, no symbol). */
export function fmtMinorPlain(minor: number | null | undefined): string {
  if (minor == null || !Number.isFinite(minor)) return "—";
  return (minor / MINOR_FACTOR).toFixed(MINOR_DIGITS);
}

/** Decimal string ("1500.50") → minor (150050) or null when invalid. */
export function parseMoneyToMinor(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const padded = (frac + "00").slice(0, MINOR_DIGITS);
  return Number(whole) * MINOR_FACTOR + Number(padded);
}

/** Validation message for money inputs (2 decimals, non-negative). */
export function moneyProblem(text: string): string | null {
  if (!text.trim()) return "Enter an amount like 1500.00.";
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return "Use up to 2 decimals, e.g. 1500.50.";
  return null;
}

/* ---- meal accents ---- */

/** Hex accent per API colorToken (admin count cards, config card accents). */
const MEAL_HEX: Record<string, string> = {
  amber: "#f59e0b",
  emerald: "#10b981",
  frost: "#2dd4bf",
  rose: "#f43f5e",
  sky: "#06b6d4",
  slate: "#64748b",
  teal: "#14b8a6",
  violet: "#a855f7",
};

/** Hex accent for a meal colorToken (defaults to the teal primary). */
export function mealHex(token: string | null | undefined): string {
  if (!token) return "#14b8a6";
  return MEAL_HEX[token.toLowerCase()] ?? "#14b8a6";
}

/** Initials for avatar tiles ("Aisha Khan" → "AK"). */
export function initialsOf(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase();
}

/* ---- dates & times (institution-agnostic display) ---- */

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(year: number, month1to12: number): string {
  return `${MONTHS_SHORT[(month1to12 - 1 + 12) % 12]} ${year}`;
}

/** ISO → "3 Sep 2026" (date-only for UTC date-key markers). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** ISO → "3 Sep" (compact). */
export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/** ISO in institution tz → "3 Sep, 2:20 PM". */
export function fmtDateTime(iso: string | null | undefined, tz = "Asia/Kolkata"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
  } catch {
    return d.toISOString();
  }
}

/** ISO in institution tz → "2:20 PM". */
export function fmtTime(iso: string | null | undefined, tz = "Asia/Kolkata"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
  } catch {
    return "—";
  }
}

/** "09:00" -> "9:00 AM", "20:00" -> "8:00 PM". */
export function formatHhMm(hhmm: string | null | undefined): string {
  if (!hhmm) return "—";
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  let hour = Number(m[1]);
  const minute = m[2];
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${ampm}`;
}

/** Friendly relative time: "just now", "12 min ago", "3 h ago", "2 d ago", else date. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} d ago`;
  return fmtDate(iso);
}

/** Calendar-day bucket for grouping: "Today" | "Yesterday" | "Earlier". */
export function dayBucket(iso: string): "Today" | "Yesterday" | "Earlier" {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOf(now);
  const day = startOf(d);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return "Earlier";
}

/** YYYY-MM-DD key for "today" on the client clock. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Shift a YYYY-MM-DD key by n days (client-local arithmetic). */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "1,2,3,4,5" → "Mon–Fri" style compact label. */
export function weekdaysCsvLabel(csv: string | null | undefined): string {
  if (!csv) return "—";
  const nums = csv.split(",").map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 7);
  if (nums.length === 0) return "—";
  const labels = WEEKDAY_LABELS.map((l, i) => (nums.includes(i + 1) ? l : null));
  let runStart = -1;
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (labels[i] && runStart < 0) runStart = i;
    if ((!labels[i] || i === 6) && runStart >= 0) {
      const runEnd = labels[i] ? i : i - 1;
      parts.push(runStart === runEnd ? WEEKDAY_LABELS[runStart] : `${WEEKDAY_LABELS[runStart]}–${WEEKDAY_LABELS[runEnd]}`);
      runStart = -1;
    }
  }
  return parts.join(", ");
}

/** Plain-words cutoff explanation (step 3 of the meal wizard). */
export function cutoffPlainWords(strategy: string, offsetDays: number, time: string): string {
  const formattedTime = formatHhMm(time);
  switch (strategy) {
    case "SAME_DAY":
      return `Residents can change until ${formattedTime} on the same day. After that the meal locks.`;
    case "PREVIOUS_DAY":
      return `Residents can change until ${formattedTime} on the previous day. After that the meal locks.`;
    case "CUSTOM_OFFSET": {
      const d = offsetDays === 0 ? "the same day" : `${offsetDays} day${offsetDays === 1 ? "" : "s"} before`;
      return `Residents can change until ${formattedTime} ${d}. After that the meal locks.`;
    }
    default:
      return "Residents can change until the cutoff time. After that the meal locks.";
  }
}

/** Meal schedule in plain words. */
export function scheduleLabel(strategy: string, weekdaysCsv: string | null, specificDate: string | null): string {
  if (strategy === "DAILY") return "Every day";
  if (strategy === "WEEKDAYS") return weekdaysCsvLabel(weekdaysCsv);
  if (strategy === "ONE_TIME") return specificDate ? `One-time · ${fmtDate(specificDate)}` : "One-time";
  return strategy;
}
