"use client";

/**
 * Stable icon wrapper components (lint-clean: no components created during
 * render — the wrapper itself owns the map lookup and renders the icon).
 */
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  FileText,
  Landmark,
  ListChecks,
  Moon,
  Sandwich,
  Sunrise,
  TriangleAlert,
  Utensils,
  Soup,
  Salad,
  Sunset,
  type LucideIcon,
} from "lucide-react";

const MEAL_ICONS: Record<string, LucideIcon> = {
  coffee: Sunrise,
  utensils: Utensils,
  moon: Moon,
  sunset: Sunset,
  soup: Soup,
  salad: Salad,
  sandwich: Sandwich,
  breakfast: Sunrise,
  lunch: Utensils,
  dinner: Moon,
  snack: Sandwich,
};

const NOTIFICATION_ICONS: Record<string, LucideIcon> = {
  MEAL_OVERRIDDEN: Utensils,
  MEAL_TOGGLED: Utensils,
  BILL_GENERATED: FileText,
  TASK_ASSIGNED: ListChecks,
  TASK_SUBMITTED: ListChecks,
  TASK_ACCEPTED: ListChecks,
  TASK_REJECTED: TriangleAlert,
  PAYMENT_APPROVED: CheckCircle2,
  PAYMENT_SUBMITTED: Landmark,
  PAYMENT_REJECTED: TriangleAlert,
  LEAVE_APPROVED: CalendarClock,
  LEAVE_REJECTED: TriangleAlert,
  GUEST_MEAL_ADDED: Utensils,
  ANNOUNCEMENT: Bell,
};

export function MealIcon({ name, className }: { name?: string | null; className?: string }) {
  const key = (name ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const Comp = MEAL_ICONS[key] ?? Utensils;
  return <Comp className={className} aria-hidden />;
}

export function NotificationIcon({ type, className }: { type: string; className?: string }) {
  const Comp = NOTIFICATION_ICONS[type] ?? Bell;
  return <Comp className={className} aria-hidden />;
}
