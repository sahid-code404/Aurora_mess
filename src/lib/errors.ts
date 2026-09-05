/**
 * API error envelope + domain error codes (spec §78).
 * Frontend maps these codes to plain-language copy. Never leak SQL/stack/paths.
 */
import { NextResponse } from "next/server";
import { logUnexpectedError } from "@/lib/observability";

export type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; fields?: Record<string, string>; requestId: string } };

export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;
  constructor(code: string, message: string, status = 400, fields?: Record<string, string>) {
    super(message);
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

// Domain codes (growing registry — frontend keeps a copy for friendly copy)
export const CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RESOURCE_CHANGED: "RESOURCE_CHANGED",
  MEAL_CUTOFF_PASSED: "MEAL_CUTOFF_PASSED",
  MEAL_NOT_AVAILABLE: "MEAL_NOT_AVAILABLE",
  PAYMENT_ALREADY_REVIEWED: "PAYMENT_ALREADY_REVIEWED",
  PAYMENT_INVALID_STATE: "PAYMENT_INVALID_STATE",
  EXPENSE_INVALID_STATE: "EXPENSE_INVALID_STATE",
  BILLING_PERIOD_CLOSED: "BILLING_PERIOD_CLOSED",
  BILLING_NOT_READY: "BILLING_NOT_READY",
  BILLING_ALREADY_BILLED: "BILLING_ALREADY_BILLED",
  BILLING_CONFIRMATION_FAILED: "BILLING_CONFIRMATION_FAILED",
  FORMULA_INVALID: "FORMULA_INVALID",
  FORMULA_UNKNOWN_VARIABLE: "FORMULA_UNKNOWN_VARIABLE",
  FORMULA_DIVIDE_BY_ZERO: "FORMULA_DIVIDE_BY_ZERO",
  INSUFFICIENT_REFUND_CREDIT: "INSUFFICIENT_REFUND_CREDIT",
  IDPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  ACCOUNT_PENDING: "ACCOUNT_PENDING",
  ACCOUNT_REJECTED: "ACCOUNT_REJECTED",
  ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  TASK_INVALID_STATE: "TASK_INVALID_STATE",
  FILE_INVALID: "FILE_INVALID",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  LOCK_REQUIRED: "LOCK_REQUIRED",
  INTERNAL: "INTERNAL_ERROR",
} as const;

export function newRequestId(): string {
  return crypto.randomUUID();
}

function withRequestId(response: NextResponse, requestId?: string): NextResponse {
  if (requestId) response.headers.set("x-request-id", requestId);
  return response;
}

export function ok<T>(data: T, meta?: Record<string, unknown>, requestId?: string): NextResponse {
  const body: ApiEnvelope<T> = meta
    ? { ok: true, data, meta: { ...meta, requestId } }
    : { ok: true, data, meta: { requestId } };
  return withRequestId(NextResponse.json(body), requestId);
}

export function fail(error: unknown, requestId: string): NextResponse {
  if (error instanceof ApiError) {
    const body: ApiEnvelope<never> = {
      ok: false,
      error: { code: error.code, message: error.message, fields: error.fields, requestId },
    };
    return withRequestId(NextResponse.json(body, { status: error.status }), requestId);
  }
  // Unexpected — log server-side only, return generic message + requestId for support.
  logUnexpectedError(requestId, error);
  const body: ApiEnvelope<never> = {
    ok: false,
    error: {
      code: CODES.INTERNAL,
      message: "Something went wrong on our side. Please try again.",
      requestId,
    },
  };
  return withRequestId(NextResponse.json(body, { status: 500 }), requestId);
}
