"use client";

/**
 * Query hook that keeps the response envelope's `meta` (KPIs, cursors).
 * Uses the "apiE" key prefix so it never collides with useApiQuery caches.
 * Mutations invalidate via invalidateApi() which covers both prefixes.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type PlaceholderDataFunction,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiClientError } from "@/lib/api";

export interface Envelope<T> {
  data: T;
  meta: Record<string, unknown>;
}

export interface UseMetaQueryOptions {
  enabled?: boolean;
  refetchInterval?: number;
  refetchOnWindowFocus?: boolean;
  staleTime?: number;
  placeholderData?: PlaceholderDataFunction<any>;
}

interface EnvelopeBody<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

interface ErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    requestId: string;
  };
}

type ResponseBody<T> = EnvelopeBody<T> | ErrorBody;

export function useApiMetaQuery<T>(
  path: string | null,
  params?: Record<string, string | number | undefined>,
  options?: UseMetaQueryOptions
): UseQueryResult<Envelope<T>, ApiClientError> {
  return useQuery({
    queryKey: ["apiE", path, params ?? {}],
    queryFn: async (): Promise<Envelope<T>> => {
      const url = new URL(path as string, window.location.origin);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
        }
      }
      const res = await fetch(url.pathname + url.search, { credentials: "same-origin" });
      let body: ResponseBody<T> | null = null;
      try {
        body = (await res.json()) as ResponseBody<T>;
      } catch {
        /* non-JSON body */
      }
      if (!body || !body.ok) {
        const err =
          body && !body.ok
            ? body.error
            : { code: "NETWORK", message: "Could not reach the server. Check your connection and try again.", requestId: "" };
        throw new ApiClientError(err.code, err.message, res.status, err.fields, err.requestId);
      }
      return { data: body.data, meta: (body.meta as Record<string, unknown>) ?? {} };
    },
    enabled: path !== null && options?.enabled !== false,
    retry: false,
    staleTime: options?.staleTime ?? 15_000,
    placeholderData: (options?.placeholderData ?? keepPreviousData) as any,
    refetchInterval: options?.refetchInterval,
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? true,
  }) as UseQueryResult<Envelope<T>, ApiClientError>;
}

/** Number from a meta object (defensive when absent). */
export function metaNum(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** String from a meta object (defensive when absent). */
export function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

/**
 * Invalidate every cached query for the given API paths (covers both the
 * useApiQuery ["api", …] and useApiMetaQuery ["apiE", …] caches, across
 * filter-param variants via prefix matching).
 */
export function useInvalidate(): (paths: string[]) => void {
  const qc = useQueryClient();
  return (paths: string[]) => {
    for (const p of paths) {
      void qc.invalidateQueries({
        predicate: (query) => {
          const first = query.queryKey[0];
          const second = query.queryKey[1];
          if ((first === "api" || first === "apiE") && typeof second === "string") {
            return (
              second === p ||
              second.startsWith(`${p}?`) ||
              second.startsWith(`${p}/`) ||
              p.startsWith(second)
            );
          }
          return false;
        },
      });
    }
  };
}

/** Typed mutation helper with the same conventions as useApiMutation. */
export function useApiMutation2<TData, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<TData>
): UseMutationResult<TData, ApiClientError, TVariables> {
  return useMutation<TData, ApiClientError, TVariables>({ mutationFn, retry: false });
}

/** Map an ApiClientError to a short toast message (backend copy is plain language). */
export function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === "NETWORK") return "Could not reach the server.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}
