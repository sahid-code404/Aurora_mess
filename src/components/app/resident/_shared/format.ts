"use client";

/**
 * Formatting + copy helpers for the resident views (Task 5-b).
 * All times are rendered in the INSTITUTION timezone (from the session).
 * All money is Int paise; rendering mirrors @/components/glass/Money.
 */

import { Coffee, Moon, Sun, Sunrise, Sunset, Utensils, UtensilsCrossed, Soup, Salad, Sandwich, Bell, FileText, ListChecks, CheckCircle2, Landmark, TriangleAlert, CalendarClock, type LucideIcon } from "lucide-react";
import { ApiClientError } from "@/lib/api";

const MINOR_DIGITS = 2;
const MINOR_FACTOR = 10 ** MINOR_DIGITS;

/** Integer minor units → "₹1,23,456.78" (en-IN, true minus sign). */
export function formatMinor(minor: number, opts?: { withSign?: boolean }): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_FACTOR);
  const frac = String(abs % MINOR_FACTOR).padStart(MINOR_DIGITS, "0");
  const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(whole);
  const sign = neg ? "−" : opts?.withSign ? "+" : "";
  return `${sign}₹${grouped}.${frac}`;
}

/** Decimal string ("55", "55.5", "55.00") → minor units, or null when invalid. */
export function parseAmountToMinor(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "00").slice(0, 2);
  const minor = Number(whole) * MINOR_FACTOR + Number(padded || "0");
  return Number.isFinite(minor) && minor > 0 ? minor : null;
}

/* --------------------------------- time ----------------------------------- */

export function formatTimeInTz(iso: string, tz: string): string {
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

/** "7:00 AM – 9:30 AM" */
export function formatWindowInTz(startIso: string, endIso: string, tz: string): string {
  const start = formatTimeInTz(startIso, tz);
  const end = formatTimeInTz(endIso, tz);
  return `${start} – ${end}`;
}

export function dateKeyInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function todayKeyInTz(tz: string): string {
  return dateKeyInTz(new Date(), tz);
}

/** "3 Sep 2026, 9:24 PM" style (used for lists). */
export function formatDateTimeInTz(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
  } catch {
    return d.toISOString();
  }
}

/** "3 Sep 2026" (no time). */
export function formatDateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/** Group label for notification feeds: Today / Yesterday / a weekday+date. */
export function dayGroupLabel(iso: string, tz: string, todayKey: string, yesterdayKey: string): string {
  const key = dateKeyInTz(new Date(iso), tz);
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

/** Sticky agenda header: "Today · Thu, 3 Sep" etc. */
export function agendaDateLabel(dateKey: string, todayKey: string, tomorrowKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(date);
  const dayMonth = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
  let prefix = "";
  if (dateKey === todayKey) prefix = "Today · ";
  else if (dateKey === tomorrowKey) prefix = "Tomorrow · ";
  else if (dateKey < todayKey) prefix = "Past · ";
  return `${prefix}${weekday}, ${dayMonth}`;
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return dateKeyInTz(date, "UTC");
}

/** "2h 14m left" / "14m left" / "" when already past. */
export function countdownLabel(msLeft: number): string {
  if (msLeft <= 0) return "";
  const minutes = Math.floor(msLeft / 60_000);
  if (minutes < 1) return "less than a minute left";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? "s" : ""} left`;
  }
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

/* ------------------------------ meal visuals ------------------------------ */

const MEAL_ICONS: Record<string, LucideIcon> = {
  coffee: Coffee,
  coffee_cup: Coffee,
  tea: Coffee,
  utensils: Utensils,
  utensils_crossed: UtensilsCrossed,
  moon: Moon,
  moon_star: Moon,
  sun: Sun,
  sunrise: Sunrise,
  sunset: Sunset,
  soup: Soup,
  salad: Salad,
  sandwich: Sandwich,
  breakfast: Sunrise,
  lunch: Utensils,
  dinner: Moon,
  snack: Sandwich,
};

export function mealIcon(icon: string | null | undefined): LucideIcon {
  if (!icon) return Utensils;
  return MEAL_ICONS[icon.toLowerCase().replace(/[\s-]+/g, "_")] ?? Utensils;
}

/* ---------------------------- notification icons --------------------------- */

export const NOTIFICATION_ICONS: Record<string, LucideIcon> = {
  MEAL_OVERRIDDEN: Utensils,
  MEAL_TOGGLED: Utensils,
  BILL_GENERATED: FileText,
  TASK_ASSIGNED: ListChecks,
  TASK_SUBMITTED: ListChecks,
  TASK_ACCEPTED: ListChecks,
  TASK_REJECTED: TriangleAlert,
  TASK_CANCELLED: TriangleAlert,
  PAYMENT_APPROVED: CheckCircle2,
  PAYMENT_SUBMITTED: Landmark,
  PAYMENT_REJECTED: TriangleAlert,
  LEAVE_APPROVED: CalendarClock,
  LEAVE_REJECTED: TriangleAlert,
  GUEST_MEAL_ADDED: Utensils,
  GUEST_MEAL_ADJUSTED: Utensils,
  GUEST_MEAL_CANCELLED: Utensils,
  ANNOUNCEMENT: Bell,
};

export function notificationIcon(type: string): LucideIcon {
  return NOTIFICATION_ICONS[type] ?? Bell;
}

/** Tailwind tint classes per API colorToken (NO blue/indigo). */
const MEAL_TINTS: Record<string, string> = {
  amber: "bg-amber-500/14 text-amber-700 dark:text-amber-300 border-amber-500/30",
  emerald: "bg-emerald-500/14 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  frost: "bg-primary/12 text-primary border-primary/28",
  rose: "bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/30",
  sky: "bg-teal-500/12 text-teal-700 dark:text-teal-300 border-teal-500/30",
  violet: "bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-500/30",
};

export function mealTint(colorToken: string | null | undefined): string {
  if (!colorToken) return MEAL_TINTS.frost;
  return MEAL_TINTS[colorToken.toLowerCase()] ?? MEAL_TINTS.frost;
}

/* --------------------------- friendly error copy --------------------------- */

/**
 * Plain-language copy for ApiClientError codes, resident-phrased
 * (spec §150-152, §158 — simple words only). Falls back to the server's
 * own message (backend messages are already plain-language).
 */
export function friendlyError(error: unknown, fallback?: string): string {
  if (!(error instanceof ApiClientError) && !(error instanceof Error)) {
    return fallback ?? "Something went wrong. Please try again.";
  }
  return error.message || fallback || "Something went wrong. Please try again.";
}

/* ------------------------------ misc helpers ------------------------------ */

export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** Month name for a bill period (year + month number). */
export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1))
  );
}