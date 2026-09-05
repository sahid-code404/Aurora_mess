"use client";

/**
 * Thin TanStack Query wrappers over the typed client in "@/lib/api".
 * Conventions for this app:
 *   - queries:   useApiQuery<T>(path, params?, options?)
 *   - mutations: useApiMutation<TData, TBody>(fn) with helpers postJson/patchJson
 *   - retry: false by default (backend may be mid-build; errors render states)
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  type PlaceholderDataFunction,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { api, apiGet, ApiClientError } from "@/lib/api";

export interface UseApiQueryOptions {
  /** Disable the query (e.g. not authenticated yet). Default: enabled. */
  enabled?: boolean;
  /** Poll interval in ms. */
  refetchInterval?: number;
  /** Stale time in ms. Default 15s. */
  staleTime?: number;
  /** Refetch when the window regains focus. Default false. */
  refetchOnWindowFocus?: boolean;
  /** Custom placeholder data; defaults to keepPreviousData to prevent page/skeleton flickering. */
  placeholderData?: PlaceholderDataFunction<any>;
}

/** Query a GET endpoint. Pass `null` as path to keep the query dormant. */
export function useApiQuery<T>(
  path: string | null,
  params?: Record<string, string | number | undefined>,
  options?: UseApiQueryOptions
): UseQueryResult<T, ApiClientError> {
  return useQuery({
    queryKey: ["api", path, params ?? {}],
    queryFn: () => apiGet<T>(path as string, params),
    enabled: path !== null && options?.enabled !== false,
    retry: false,
    staleTime: options?.staleTime ?? 15_000,
    placeholderData: (options?.placeholderData ?? keepPreviousData) as any,
    refetchInterval: options?.refetchInterval,
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
  }) as UseQueryResult<T, ApiClientError>;
}

/** Typed JSON verb helpers for mutations. */
export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", json: body });

export const patchJson = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "PATCH", json: body });

export const deleteJson = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: "DELETE", json: body });

/**
 * Mutation helper — pass a typed function; useApiMutation wires TanStack
 * conventions (no retry, ApiClientError as the error channel).
 *
 *   const login = useApiMutation<void, Credentials>((b) => postJson("/api/v1/auth/login", b))
 *   login.mutate({ email, password }, { onError: (e) => ... })
 */
export function useApiMutation<TData, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<TData>
): UseMutationResult<TData, ApiClientError, TVariables> {
  return useMutation<TData, ApiClientError, TVariables>({
    mutationFn,
    retry: false,
  });
}
