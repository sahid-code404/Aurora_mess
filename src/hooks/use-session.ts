"use client";

/**
 * Session hook — the single source of auth truth on the client.
 * Queries GET /api/v1/auth/me via TanStack; any failure (including the
 * endpoint not existing yet) resolves to an unauthenticated state so the
 * AuthScreen renders without crash loops.
 */

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiGet, ApiClientError, clearSessionToken } from "@/lib/api";
import type { UseQueryResult } from "@tanstack/react-query";

export type SessionRole = "ADMIN" | "RESIDENT";

export interface SessionUser {
  id: string;
  role: SessionRole;
  email: string;
  status: string;
}

export interface SessionProfile {
  fullName: string;
  room?: string | null;
  phone?: string | null;
}

export interface SessionInstitution {
  name: string;
  timezone: string;
  currencyCode: string;
}

export interface SessionPayload {
  user: SessionUser;
  profile: SessionProfile;
  institution: SessionInstitution;
}

export const SESSION_PATH = "/api/v1/auth/me";

export interface UseSessionResult {
  user: SessionUser | null;
  profile: SessionProfile | null;
  institution: SessionInstitution | null;
  /** True while the first /auth/me request is in flight. */
  isLoading: boolean;
  /** Set when the query definitively failed (treated as signed out). */
  error: ApiClientError | null;
  query: UseQueryResult<SessionPayload, ApiClientError>;
  refetch: () => void;
  logout: () => Promise<void>;
}

export function useSession(): UseSessionResult {
  const queryClient = useQueryClient();

  const query = useQuery<SessionPayload, ApiClientError>({
    queryKey: ["api", SESSION_PATH],
    queryFn: () => apiGet<SessionPayload>(SESSION_PATH),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  const logout = useCallback(async () => {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Session is being discarded locally regardless — ignore transport errors.
    }
    // Drop the Bearer fallback token along with the cookie session, then
    // RESET all cached API state. resetQueries (unlike clear) synchronously
    // moves every active query — including this session query — to pending,
    // so the shell unmounts immediately (loading curtain → auth screen)
    // instead of lingering on orphaned cache data with 401 error states.
    clearSessionToken();
    void queryClient.resetQueries({ queryKey: ["api"] });
  }, [queryClient]);

  const authenticated = query.data != null && query.isSuccess;

  return {
    user: authenticated ? query.data.user : null,
    profile: authenticated ? query.data.profile : null,
    institution: authenticated ? query.data.institution : null,
    isLoading: query.isPending,
    error: query.error ?? null,
    query,
    refetch,
    logout,
  };
}
