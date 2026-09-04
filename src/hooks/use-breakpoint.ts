"use client";

/**
 * Media-query hooks for the responsive shell.
 * Desktop = lg breakpoint (persistent sidebar from 1024px up).
 */

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** True at ≥1024px — the desktop shell (sidebar, inline filter panels). */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
