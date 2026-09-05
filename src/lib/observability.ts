type ApiRequestLog = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  authMode: string;
  actorUserId?: string;
  actorRole?: string;
  institutionId?: string;
  errorCode?: string;
};

function requestLoggingEnabled(): boolean {
  if (process.env.API_REQUEST_LOGGING === "1") return true;
  if (process.env.API_REQUEST_LOGGING === "0") return false;
  return process.env.NODE_ENV === "production";
}

function emit(level: "info" | "warn" | "error", payload: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "boardops",
    ...payload,
  });
  console[level](line);
}

/**
 * One structured record per API request in production by default.
 * Deliberately excludes URL query strings, bodies, cookies, tokens, emails,
 * user agents and IP addresses. The requestId is safe to surface to clients.
 */
export function logApiRequest(input: ApiRequestLog): void {
  if (!requestLoggingEnabled()) return;

  const payload: Record<string, unknown> = {
    event: "api_request",
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    authMode: input.authMode,
  };
  if (input.actorUserId) payload.actorUserId = input.actorUserId;
  if (input.actorRole) payload.actorRole = input.actorRole;
  if (input.institutionId && input.institutionId !== "public") {
    payload.institutionId = input.institutionId;
  }
  if (input.errorCode) payload.errorCode = input.errorCode;

  const level = input.status >= 500 ? "error" : input.status >= 400 ? "warn" : "info";
  emit(level, payload);
}

/** Unexpected exceptions retain correlation without dumping request data. */
export function logUnexpectedError(requestId: string, error: unknown): void {
  const details =
    error instanceof Error
      ? { errorName: error.name, errorMessage: error.message }
      : { errorName: "UnknownError", errorMessage: String(error) };

  emit("error", {
    event: "api_unexpected_error",
    requestId,
    ...details,
    ...(process.env.LOG_ERROR_STACKS === "1" && error instanceof Error && error.stack
      ? { stack: error.stack }
      : {}),
  });
}
