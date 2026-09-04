"use client";

/**
 * Envelope-aware client helpers for the resident views (Task 5-b).
 *
 * `useApiQuery` from the shared hooks returns ONLY `data` — but several
 * resident endpoints carry essential list metadata (meal month counters +
 * serverTime, payment KPIs, unread counts). These helpers keep the SAME
 * query-key format (["api", path, params]) so prefix invalidation works
 * uniformly across the app.
 */

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type PlaceholderDataFunction,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiClientError, type ApiEnvelope } from "@/lib/api";

export interface Envelope<T, M> {
  data: T;
  meta: M;
}

/** GET an endpoint keeping both data and meta. */
export async function apiGetEnvelope<T, M = Record<string, unknown>>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<Envelope<T, M>> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.pathname + url.search, { credentials: "same-origin" });
  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    /* non-JSON body */
  }
  if (!body || !body.ok) {
    const err = body && !body.ok ? body.error : { code: "NETWORK", message: "Could not reach the server. Check your connection and try again.", requestId: "" };
    throw new ApiClientError(err.code, err.message, res.status, err.fields, err.requestId);
  }
  return { data: body.data, meta: (body.meta ?? {}) as M };
}

export interface UseEnvelopeQueryOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number;
  placeholderData?: PlaceholderDataFunction<any>;
}

/** TanStack query over apiGetEnvelope — same key convention as useApiQuery. */
export function useEnvelopeQuery<T, M = Record<string, unknown>>(
  path: string | null,
  params?: Record<string, string | number | undefined>,
  options?: UseEnvelopeQueryOptions
): UseQueryResult<Envelope<T, M>, ApiClientError> {
  return useQuery({
    queryKey: ["api", path, params ?? {}],
    queryFn: () => apiGetEnvelope<T, M>(path as string, params),
    enabled: path !== null && options?.enabled !== false,
    retry: false,
    staleTime: options?.staleTime ?? 15_000,
    placeholderData: (options?.placeholderData ?? keepPreviousData) as any,
    refetchInterval: options?.refetchInterval,
    refetchOnWindowFocus: false,
  }) as UseQueryResult<Envelope<T, M>, ApiClientError>;
}

/* ------------------------------ mutations ------------------------------ */

/** POST/PATCH JSON, returning `data` (throws ApiClientError on failure). */
export async function apiJson<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  let parsed: ApiEnvelope<T> | null = null;
  try {
    parsed = (await res.json()) as ApiEnvelope<T>;
  } catch {
    /* non-JSON body */
  }
  if (!parsed || !parsed.ok) {
    const err = parsed && !parsed.ok ? parsed.error : { code: "NETWORK", message: "Could not reach the server. Check your connection and try again.", requestId: "" };
    throw new ApiClientError(err.code, err.message, res.status, err.fields, err.requestId);
  }
  return parsed.data;
}

/** POST multipart/form-data (payments, task submissions). */
export async function apiMultipart<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body: form });
  let parsed: ApiEnvelope<T> | null = null;
  try {
    parsed = (await res.json()) as ApiEnvelope<T>;
  } catch {
    /* non-JSON body */
  }
  if (!parsed || !parsed.ok) {
    const err = parsed && !parsed.ok ? parsed.error : { code: "NETWORK", message: "Could not reach the server. Check your connection and try again.", requestId: "" };
    throw new ApiClientError(err.code, err.message, res.status, err.fields, err.requestId);
  }
  return parsed.data;
}

/* --------------------------- cache invalidation --------------------------- */

/** Resident query-key prefixes that mutations should refresh. */
export const RESIDENT_KEYS = {
  dashboard: "/api/v1/me/dashboard",
  meals: "/api/v1/meals",
  guestMeals: "/api/v1/guest-meals",
  leaveRequests: "/api/v1/leave-requests",
  billing: "/api/v1/billing",
  bills: "/api/v1/bills",
  payments: "/api/v1/payments",
  tasks: "/api/v1/tasks",
  notifications: "/api/v1/notifications",
  profile: "/api/v1/me/profile",
} as const;

export type ResidentArea = (typeof RESIDENT_KEYS)[keyof typeof RESIDENT_KEYS];

/** Invalidate one or more resident areas (prefix match → covers all params). */
export function useInvalidateResident() {
  const queryClient = useQueryClient();
  return (areas: ResidentArea[]) => {
    for (const path of areas) {
      void queryClient.invalidateQueries({ queryKey: ["api", path] });
    }
  };
}
