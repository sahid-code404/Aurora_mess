#!/usr/bin/env bash
set -euo pipefail

CHECK_MODE="${1:-all}"
case "$CHECK_MODE" in
  all|process|readiness|auth) ;;
  *) echo "unknown production smoke mode: $CHECK_MODE" >&2; exit 2 ;;
esac

PORT="${BOARDOPS_SMOKE_PORT:-3100}"
HOST="127.0.0.1"
BASE_URL="http://${HOST}:${PORT}"
SERVER_LOG="$(mktemp)"
BODY_FILE="$(mktemp)"
SERVER_PID=""
SMOKE_EMAIL="phase13-nobody-${GITHUB_RUN_ID:-local}@example.com"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_LOG" "$BODY_FILE"
}
trap cleanup EXIT

fail() {
  echo "production runtime smoke failed ($CHECK_MODE): $*" >&2
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

request_status() {
  local expected="$1"
  local label="$2"
  shift 2
  local actual
  actual="$(curl --silent --show-error --max-time 10 --output "$BODY_FILE" --write-out "%{http_code}" "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "--- response body ($label) ---" >&2
    cat "$BODY_FILE" >&2 || true
    fail "$label returned HTTP $actual; expected $expected"
  fi
}

assert_json() {
  local assertion="$1"
  python3 - "$BODY_FILE" "$assertion" <<'PY'
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
elif assertion == "invalid_credentials_no_token":
    def contains_session_token(value):
        if isinstance(value, dict):
            return "sessionToken" in value or any(contains_session_token(v) for v in value.values())
        if isinstance(value, list):
            return any(contains_session_token(v) for v in value)
        return False
    ok = payload.get("ok") is False and payload.get("error", {}).get("code") == "INVALID_CREDENTIALS" and not contains_session_token(payload)
elif assertion == "forbidden":
    ok = payload.get("ok") is False and payload.get("error", {}).get("code") == "FORBIDDEN"
else:
    raise SystemExit(f"unknown assertion: {assertion}")

if not ok:
    raise SystemExit(f"JSON assertion failed ({assertion}): {payload!r}")
PY
}

export NODE_ENV=production
export PORT
export HOSTNAME="$HOST"
export ENABLE_PREVIEW_BEARER_AUTH=0

bun .next/standalone/server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

# Every stage first proves the actual standalone process boots and serves HTTP.
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
  request_status 200 "application root" "$BASE_URL/"
fi

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "readiness" ]; then
  request_status 200 "database readiness" "$BASE_URL/api/v1/health/ready"
  assert_json ready
fi

if [ "$CHECK_MODE" = "all" ] || [ "$CHECK_MODE" = "auth" ]; then
  request_status 401 "unauthenticated session" "$BASE_URL/api/v1/auth/me"
  assert_json unauthenticated

  request_status 401 "invalid same-origin login" \
    -X POST "$BASE_URL/api/v1/auth/login" \
    -H "Origin: $BASE_URL" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"SmokePassword123\"}"
  assert_json invalid_credentials_no_token

  request_status 403 "cross-site mutation" \
    -X POST "$BASE_URL/api/v1/auth/logout" \
    -H "Origin: https://attacker.invalid" \
    -H "Sec-Fetch-Site: cross-site"
  assert_json forbidden
fi

echo "production standalone runtime smoke passed ($CHECK_MODE)"
