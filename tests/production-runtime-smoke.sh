#!/usr/bin/env bash
set -euo pipefail

CHECK_MODE="${1:-all}"
case "$CHECK_MODE" in
  all|process|readiness|session|login|login-status|login-code|login-token|csrf) ;;
  *) echo "unknown production smoke mode: $CHECK_MODE" >&2; exit 2 ;;
esac

PORT="${BOARDOPS_SMOKE_PORT:-3100}"
HOST="127.0.0.1"
BASE_URL="http://${HOST}:${PORT}"
SERVER_LOG="$(mktemp)"
BODY_FILE="$(mktemp)"
SERVER_PID=""
CURRENT_STAGE="bootstrap"
SMOKE_EMAIL="phase13-nobody-${GITHUB_RUN_ID:-local}@example.com"
DIAGNOSTIC_DIR="${BOARDOPS_SMOKE_DIAGNOSTIC_DIR:-}"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_LOG" "$BODY_FILE"
}
trap cleanup EXIT

persist_diagnostics() {
  local message="$1"
  if [ -z "$DIAGNOSTIC_DIR" ]; then
    return
  fi
  mkdir -p "$DIAGNOSTIC_DIR"
  {
    printf 'mode=%s\n' "$CHECK_MODE"
    printf 'stage=%s\n' "$CURRENT_STAGE"
    printf 'message=%s\n' "$message"
  } >"$DIAGNOSTIC_DIR/failure.txt"
  cp "$BODY_FILE" "$DIAGNOSTIC_DIR/response-body.txt" 2>/dev/null || true
  cp "$SERVER_LOG" "$DIAGNOSTIC_DIR/server.log" 2>/dev/null || true
}

fail() {
  local message="$*"
  persist_diagnostics "$message"
  echo "production runtime smoke failed ($CHECK_MODE/$CURRENT_STAGE): $message" >&2
  echo "--- response body ---" >&2
  cat "$BODY_FILE" >&2 || true
  echo "--- standalone server log ---" >&2
  cat "$SERVER_LOG" >&2 || true
  exit 1
}

case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*) ;;
  *) fail "DATABASE_URL must point to PostgreSQL" ;;
esac

if [ -z "${SESSION_SECRET:-}" ]; then
  fail "SESSION_SECRET is required"
fi

if [ ! -f ".next/standalone/server.js" ]; then
  fail ".next/standalone/server.js is missing; run the production build first"
fi

request_capture() {
  curl --silent --show-error --max-time 10 --output "$BODY_FILE" --write-out "%{http_code}" "$@"
}

request_status() {
  local expected="$1"
  local label="$2"
  shift 2
  local actual
  actual="$(request_capture "$@")"
  if [ "$actual" != "$expected" ]; then
    fail "$label returned HTTP $actual; expected $expected"
  fi
}

assert_json() {
  local assertion="$1"
  if ! python3 - "$BODY_FILE" "$assertion" <<'PY'
import json
import sys

path, assertion = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

if assertion == "live":
    ok = payload.get("ok") is True and payload.get("data", {}).get("ok") is True
elif assertion == "ready":
    data = payload.get("data", {})
    ok = payload.get("ok") is True and data.get("ok") is True and data.get("db") is True and isinstance(data.get("institutions"), int)
elif assertion == "unauthenticated":
    ok = payload.get("ok") is False and payload.get("error", {}).get("code") == "UNAUTHENTICATED"
elif assertion == "invalid_credentials":
    ok = payload.get("ok") is False and payload.get("error", {}).get("code") == "INVALID_CREDENTIALS"
elif assertion == "no_session_token":
    def contains_session_token(value):
        if isinstance(value, dict):
            return "sessionToken" in value or any(contains_session_token(v) for v in value.values())
        if isinstance(value, list):
            return any(contains_session_token(v) for v in value)
        return False
    ok = not contains_session_token(payload)
elif assertion == "forbidden":
    ok = payload.get("ok") is False and payload.get("error", {}).get("code") == "FORBIDDEN"
else:
    raise SystemExit(f"unknown assertion: {assertion}")

if not ok:
    raise SystemExit(f"JSON assertion failed ({assertion}): {payload!r}")
PY
  then
    fail "JSON assertion failed: $assertion"
  fi
}

login_request() {
  request_capture \
    -X POST "$BASE_URL/api/v1/auth/login" \
    -H "Origin: $BASE_URL" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"SmokePassword123\"}"
}

export NODE_ENV=production
export PORT
export HOSTNAME="$HOST"
export ENABLE_PREVIEW_BEARER_AUTH=0

CURRENT_STAGE="server-start"
bun .next/standalone/server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

CURRENT_STAGE="liveness"
live_status=""
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "standalone server exited during startup"
  fi
  live_status="$(curl --silent --max-time 2 --output "$BODY_FILE" --write-out "%{http_code}" "$BASE_URL/api/v1/health/live" 2>/dev/null || true)"
  if [ "$live_status" = "200" ]; then
    break
  fi
  sleep 0.5
done

if [ "$live_status" != "200" ]; then
  fail "standalone server did not become live"
fi
assert_json live

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "process" ]; then
  CURRENT_STAGE="application-root"
  request_status 200 "application root" "$BASE_URL/"
fi

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "readiness" ]; then
  CURRENT_STAGE="database-readiness"
  request_status 200 "database readiness" "$BASE_URL/api/v1/health/ready"
  assert_json ready
fi

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "session" ]; then
  CURRENT_STAGE="unauthenticated-session"
  request_status 401 "unauthenticated session" "$BASE_URL/api/v1/auth/me"
  assert_json unauthenticated
fi

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "login" ]; then
  CURRENT_STAGE="login-status"
  status="$(login_request)"
  if [ "$status" != "401" ]; then
    fail "invalid same-origin login returned HTTP $status; expected 401"
  fi
  CURRENT_STAGE="login-error-code"
  assert_json invalid_credentials
  CURRENT_STAGE="login-token-omission"
  assert_json no_session_token
fi

if [ "$CHECK_MODE" = "login-status" ]; then
  CURRENT_STAGE="login-status"
  status="$(login_request)"
  if [ "$status" != "401" ]; then
    fail "invalid same-origin login returned HTTP $status; expected 401"
  fi
fi

if [ "$CHECK_MODE" = "login-code" ]; then
  CURRENT_STAGE="login-error-code"
  login_request >/dev/null
  assert_json invalid_credentials
fi

if [ "$CHECK_MODE" = "login-token" ]; then
  CURRENT_STAGE="login-token-omission"
  login_request >/dev/null
  assert_json no_session_token
fi

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "csrf" ]; then
  CURRENT_STAGE="csrf-boundary"
  request_status 403 "cross-site mutation" \
    -X POST "$BASE_URL/api/v1/auth/logout" \
    -H "Origin: https://attacker.invalid" \
    -H "Sec-Fetch-Site: cross-site"
  assert_json forbidden
fi

CURRENT_STAGE="complete"
echo "production standalone runtime smoke passed ($CHECK_MODE)"
