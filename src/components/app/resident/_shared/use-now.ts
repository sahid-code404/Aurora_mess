"use client";

/**
 * Ticker + countdown helpers (Task 5-b).
 * The SERVER clock is the only truth (spec §16); the browser just renders.
 * `useNow(serverTimeIso?)` seeds from the server instant when available and
 * then ticks locally, keeping the offset stable.
 */

import { useEffect, useRef, useState } from "react";

/** Ticking "now". Seeds from serverTime (ms offset preserved), else Date.now(). */
export function useNow(serverTimeIso?: string | null, intervalMs = 10_000): number {
  const offsetRef = useRef<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!serverTimeIso) return;
    const server = new Date(serverTimeIso).getTime();
    if (Number.isFinite(server)) {
      offsetRef.current = server - Date.now();
      setNow(Date.now() + offsetRef.current);
    }
  }, [serverTimeIso]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() + offsetRef.current), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** Milliseconds until an ISO instant (negative once past). */
export function msUntil(iso: string, nowMs: number): number {
  return new Date(iso).getTime() - nowMs;
}

/** True once the cutoff instant has passed relative to the tick clock. */
export function isPast(iso: string, nowMs: number): boolean {
  return msUntil(iso, nowMs) <= 0;
}
