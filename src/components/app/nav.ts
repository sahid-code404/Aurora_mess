/**
 * nav.ts — navigation model per role (BoardOps language, user-tuned shell).
 *
 * THE SHELL (all viewports, mobile → desktop):
 *   • Bottom bar — always FIVE fixed slots: four destinations + "More".
 *       – ADMIN:    Home · Meals · Money · Residents · More
 *       – RESIDENT: Home · Meals · Payments · Billing · More
 *     The bar itself is dynamically resizable: it widens with the viewport
 *     (slots grow, labels breathe) but the slot count never changes.
 *   • More panel — the grouped navigation drawer, reachable at EVERY
 *     viewport from BOTH the top-left hamburger (always visible) and the
 *     bar's "More" slot. It carries the full taxonomy incl. Tasks,
 *     Calendar, Funds, Expenses, Billing, Formula, Config, Settings, Audit…
 * `primary` marks the four bottom-bar destinations; `shortLabel` is the
 * compact bar label; `keywords` power the ⌘K command palette. Pure data —
 * server-safe.
 */

import {
  Bell,
  CalendarDays,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Receipt,
  ScrollText,
  Settings,
  Sigma,
  SlidersHorizontal,
  UserRound,
  Users,
  UtensilsCrossed,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { SessionRole } from "@/hooks/use-session";

export interface NavItem {
  /** Route key, e.g. "admin-meals". */
  key: string;
  /** Hash path, e.g. "#/admin/meals". */
  hash: string;
  /** Full label (drawer / page title). */
  label: string;
  /** Compact label for the bottom bar (falls back to label). */
  shortLabel?: string;
  icon: LucideIcon;
  /** Bottom-bar destination — exactly four per role, plus the "More" slot. */
  primary?: boolean;
  /** Drawer group label. */
  group?: string;
  /** ⌘K palette search keywords. */
  keywords?: string[];
}

export const ADMIN_NAV: NavItem[] = [
  // Overview
  { key: "admin-dashboard", hash: "#/admin/dashboard", label: "Home", icon: LayoutDashboard, primary: true, group: "Overview", keywords: ["home", "overview", "dashboard"] },
  // Meals
  { key: "admin-meals", hash: "#/admin/meals", label: "Meal Count", shortLabel: "Meals", icon: UtensilsCrossed, primary: true, group: "Meals", keywords: ["meals", "today", "counts", "toggle", "kitchen"] },
  { key: "admin-meal-configuration", hash: "#/admin/meal-configuration", label: "Meal Configuration", shortLabel: "Config", icon: SlidersHorizontal, group: "Meals", keywords: ["meals", "config", "definition", "schedule", "price"] },
  // Finance
  { key: "admin-payments", hash: "#/admin/payments", label: "Payments", shortLabel: "Payments", icon: Wallet, primary: true, group: "Finance", keywords: ["payments", "money", "wallet", "deposit", "cash"] },
  { key: "admin-funds", hash: "#/admin/funds", label: "Funds", icon: Landmark, group: "Finance", keywords: ["funds", "balance", "deposit", "deficit"] },
  { key: "admin-expenses", hash: "#/admin/expenses", label: "Expenses", icon: Receipt, group: "Finance", keywords: ["expenses", "spend", "vendor", "purchase"] },
  { key: "admin-billing", hash: "#/admin/billing", label: "Billing", icon: FileSpreadsheet, group: "Finance", keywords: ["billing", "bills", "invoice", "closing"] },
  { key: "admin-formulas", hash: "#/admin/formula-engine", label: "Formula & Variables", shortLabel: "Engine", icon: Sigma, group: "Finance", keywords: ["formula", "variable", "expression", "rate", "custom variable", "derived variable"] },
  // People
  { key: "admin-residents", hash: "#/admin/residents", label: "Residents", icon: Users, primary: true, group: "People", keywords: ["residents", "users", "members", "people"] },
  // Operations
  { key: "admin-tasks", hash: "#/admin/tasks", label: "Tasks", icon: ListChecks, group: "Operations", keywords: ["tasks", "todo", "checklist"] },
  { key: "admin-calendar", hash: "#/admin/calendar", label: "Calendar", icon: CalendarDays, group: "Operations", keywords: ["calendar", "month", "schedule", "dates"] },
  // Communication
  { key: "admin-notifications", hash: "#/admin/notifications", label: "Notifications", icon: Bell, group: "Communication", keywords: ["notification", "alert", "bell", "unread"] },
  { key: "admin-announcements", hash: "#/admin/announcements", label: "Announcements", shortLabel: "News", icon: Megaphone, group: "Communication", keywords: ["announcement", "broadcast", "notice", "pinned"] },
  // System
  { key: "admin-settings", hash: "#/admin/settings", label: "Settings", icon: Settings, group: "System", keywords: ["settings", "config", "policy", "rules"] },
  { key: "admin-audit", hash: "#/admin/audit", label: "Audit Trail", shortLabel: "Audit", icon: ScrollText, group: "System", keywords: ["audit", "log", "history", "trace"] },
];

export const RESIDENT_NAV: NavItem[] = [
  // Overview
  { key: "app-dashboard", hash: "#/app/dashboard", label: "Home", icon: LayoutDashboard, primary: true, group: "Overview", keywords: ["home", "overview", "dashboard"] },
  // Meals
  { key: "app-meals", hash: "#/app/meals", label: "Meals", icon: UtensilsCrossed, primary: true, group: "Meals", keywords: ["meals", "today", "toggle", "on", "off"] },
  // Finance & Billing
  { key: "app-payments", hash: "#/app/payments", label: "Payments", icon: Wallet, primary: true, group: "Billing", keywords: ["payments", "pay", "history", "wallet"] },
  { key: "app-billing", hash: "#/app/billing", label: "Billing", icon: FileSpreadsheet, primary: true, group: "Billing", keywords: ["billing", "bills", "invoice", "due"] },
  // Tasks
  { key: "app-tasks", hash: "#/app/tasks", label: "Tasks", icon: ListChecks, group: "Tasks", keywords: ["tasks", "todo", "checklist"] },
  // Account (notifications/profile also reachable from the top bar)
  { key: "app-profile", hash: "#/app/profile", label: "Profile", icon: UserRound, group: "Account", keywords: ["profile", "me", "account", "avatar"] },
  { key: "app-notifications", hash: "#/app/notifications", label: "Notifications", icon: Bell, group: "Account", keywords: ["notification", "alert", "bell", "unread"] },
];

export const NAVIGATION: Record<SessionRole, NavItem[]> = {
  ADMIN: ADMIN_NAV,
  RESIDENT: RESIDENT_NAV,
};

/**
 * The FOUR fixed bottom-bar destinations per role (the fifth slot is always
 * "More" → opens the drawer). Rendered identically at every viewport.
 *   ADMIN:    Home · Meals · Payments · Residents
 *   RESIDENT: Home · Meals · Payments · Billing
 */
export function bottomBarItems(role: SessionRole): NavItem[] {
  return NAVIGATION[role].filter((i) => i.primary).slice(0, 4);
}

/** Grouped structure for the drawer + palette. */
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function navGroups(role: SessionRole): NavGroup[] {
  const nav = NAVIGATION[role];
  const groups: NavGroup[] = [];
  for (const item of nav) {
    const label = item.group ?? "More";
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (last && last.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}

/** Lookup a nav item by its route key. */
export function navItemByKey(key: string): NavItem | undefined {
  return [...ADMIN_NAV, ...RESIDENT_NAV].find((i) => i.key === key);
}

/** ⌘K palette source: every nav item + the palette-only actions. */
export function paletteItems(role: SessionRole): NavItem[] {
  return NAVIGATION[role];
}
