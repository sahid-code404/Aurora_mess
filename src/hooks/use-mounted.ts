"use client";

/**
 * useMounted — hydration-safe "are we on the client?" via useSyncExternalStore
 * (server snapshot false, client snapshot true). Avoids the setState-in-effect
 * anti-pattern flagged by the React hooks lint rules.
 */

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
