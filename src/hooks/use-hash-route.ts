"use client";

/**
 * HASH ROUTER (spec adaptation: single-page app at `/` with hash routing)
 * "#/admin/meals"            → { section: "admin", sub: "meals" }
 * "#/admin/residents/abc123" → { section: "admin", sub: "residents", param: "abc123" }
 * "#/app/billing"            → { section: "app",    sub: "billing" }
 */

import { useCallback, useEffect, useState } from "react";

export interface HashRoute {
  /** Raw hash as found in the URL, e.g. "#/admin/meals" ("" when absent). */
  raw: string;
  /** Hash without the leading "#", e.g. "/admin/meals". */
  path: string;
  /** Non-empty segments, e.g. ["admin", "meals"]. */
  segments: string[];
  /** First segment — "admin" | "app" (role area). */
  section: string;
  /** Second segment — the view key, e.g. "meals". */
  sub: string;
  /** Third segment when present — e.g. a resident id for the 360° view. */
  param?: string;
}

export function parseHash(raw: string): HashRoute {
  const path = raw.replace(/^#/, "");
  const segments = path.split("/").filter((s) => s.length > 0);
  const [section = "", sub = "", param] = segments;
  return { raw, path, segments, section, sub, param };
}

function readHash(): string {
  if (typeof window === "undefined") return "";
  return window.location.hash;
}

/** Programmatic navigation. Accepts "/admin/meals" or "#/admin/meals". */
export function navigateTo(path: string): void {
  if (typeof window === "undefined") return;
  const hash = path.startsWith("#")
    ? path
    : `#${path.startsWith("/") ? path : `/${path}`}`;
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

/** Navigate back through browser history (falls back to role default). */
export function goBack(fallbackPath?: string): void {
  if (typeof window === "undefined") return;
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  if (fallbackPath) navigateTo(fallbackPath);
}

/** Rewrite the URL hash without triggering a hashchange navigation. */
export function replaceHash(hash: string): void {
  if (typeof window === "undefined") return;
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (window.location.hash === target) return;
  window.history.replaceState(null, "", target);
}

/** Subscribe to hashchange and expose the parsed route. */
export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(() => parseHash(readHash()));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(readHash()));
    onChange();
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

/** Stable callback helper for navigating from event handlers. */
export function useNavigate() {
  return useCallback((path: string) => navigateTo(path), []);
}
