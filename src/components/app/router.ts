"use client";

/**
 * router.ts — resolves the current hash to a route key (role-aware).
 * "#/admin/meals" → { key: "admin-meals", … }
 * "#/admin/residents/:id" → { key: "admin-resident360", param: id }
 * Unknown or empty hashes resolve to the role's default route.
 */

import { useEffect } from "react";
import {
  parseHash,
  replaceHash,
  useHashRoute,
  type HashRoute,
} from "@/hooks/use-hash-route";
import type { SessionRole } from "@/hooks/use-session";

export type Role = SessionRole;

export interface AppRoute {
  /** Route key — matches a NavItem key or a view component. */
  key: string;
  /** Canonical hash, e.g. "#/admin/meals". */
  hash: string;
  section: "admin" | "app";
  view: string;
  /** Dynamic segment (resident id for the 360° view). */
  param?: string;
  /** False when the URL hash didn't match any known route (default shown). */
  matched: boolean;
}

export const DEFAULT_HASH: Record<Role, string> = {
  ADMIN: "#/admin/dashboard",
  RESIDENT: "#/app/dashboard",
};

/** All admin view slugs (used for resolution). */
const ADMIN_VIEWS = new Set([
  "dashboard",
  "meals",
  "meal-configuration",
  "payments",
  "funds",
  "expenses",
  "billing",
  "residents",
  "tasks",
  "announcements",
  "notifications",
  "calendar",
  "formulas",
  "formula-engine",
  "settings",
  "audit",
]);

/** All resident view slugs. */
const RESIDENT_VIEWS = new Set([
  "dashboard",
  "meals",
  "billing",
  "payments",
  "tasks",
  "profile",
  "notifications",
]);

export function resolveRoute(hashRoute: HashRoute, role: Role): AppRoute {
  const area = role === "ADMIN" ? "admin" : "app";
  const { section, sub, param } = hashRoute;

  // Resident ids live under #/admin/residents/:id → 360° view (admin only).
  if (role === "ADMIN" && section === "admin" && sub === "residents" && param) {
    return {
      key: "admin-resident360",
      hash: hashRoute.raw,
      section: "admin",
      view: "resident360",
      param,
      matched: true,
    };
  }

  // Support #/admin/formula-engine alias
  if (role === "ADMIN" && section === "admin" && sub === "formula-engine") {
    return {
      key: "admin-formulas",
      hash: hashRoute.raw,
      section: "admin",
      view: "formulas",
      matched: true,
    };
  }

  const viewSet = role === "ADMIN" ? ADMIN_VIEWS : RESIDENT_VIEWS;
  if (section === area && viewSet.has(sub)) {
    return { key: `${area}-${sub}`, hash: hashRoute.raw, section: area, view: sub, matched: true };
  }

  // Cross-role or unknown hash → role default.
  const fallback = parseHash(DEFAULT_HASH[role]);
  return {
    key: `${area}-${fallback.sub}`,
    hash: DEFAULT_HASH[role],
    section: area,
    view: fallback.sub,
    matched: false,
  };
}

/**
 * Role-aware route hook; silently normalizes unknown/empty hashes in the URL.
 * `ready` (default true) gates URL normalization — AppRoot passes false while
 * the session is unresolved so the visitor's deep link isn't clobbered with
 * a role-default before we know the role.
 */
export function useRoute(role: Role, ready = true): AppRoute {
  const hashRoute = useHashRoute();
  const route = resolveRoute(hashRoute, role);

  useEffect(() => {
    if (ready && (!route.matched || hashRoute.raw === "")) {
      replaceHash(DEFAULT_HASH[role]);
    }
  }, [ready, route.matched, hashRoute.raw, role]);

  return route;
}
