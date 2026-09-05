#!/usr/bin/env bash
set -euo pipefail

PORT="${BOARDOPS_SEEDED_SMOKE_PORT:-3101}"
HOST="127.0.0.1"
BASE_URL="http://${HOST}:${PORT}"
SERVER_LOG="$(mktemp)"
BODY_FILE="$(mktemp)"
HEADER_FILE="$(mktemp)"
SERVER_PID=""
CURRENT_STAGE="bootstrap"
DIAGNOSTIC_DIR="${BOARDOPS_SEEDED_SMOKE_DIAGNOSTIC_DIR:-}"

ADMIN_EMAIL="${BOARDOPS_TEST_ADMIN_EMAIL:-admin@messtest.in}"
ADMIN_PASSWORD="${BOARDOPS_TEST_ADMIN_PASSWORD:-Admin#12345}"
RESIDENT_EMAIL="${BOARDOPS_TEST_RESIDENT_EMAIL:-sahid@messtest.in}"
RESIDENT_PASSWORD="${BOARDOPS_TEST_RESIDENT_PASSWORD:-Resident#12345}"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_LOG" "$BODY_FILE" "$HEADER_FILE"
}
trap cleanup EXIT

persist_diagnostics() {
  local message="$1"
  [ -n "$DIAGNOSTIC_DIR" ] || return
  mkdir -p "$DIAGNOSTIC_DIR"
  {
    printf 'stage=%s\n' "$CURRENT_STAGE"
    printf 'message=%s\n' "$message"
  } >"$DIAGNOSTIC_DIR/failure.txt"
  cp "$BODY_FILE" "$DIAGNOSTIC_DIR/response-body.txt" 2>/dev/null || true
  cp "$SERVER_LOG" "$DIAGNOSTIC_DIR/server.log" 2>/dev/null || true
}

fail() {
  local message="$*"
  persist_diagnostics "$message"
  echo "seeded auth smoke failed ($CURRENT_STAGE): $message" >&2
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
[ -n "${SESSION_SECRET:-}" ] || fail "SESSION_SECRET is required"
[ -f ".next/standalone/server.js" ] || fail ".next/standalone/server.js is missing; run the production build first"

request_capture() {
  curl --silent --show-error --max-time 10 --output "$BODY_FILE" --write-out "%{http_code}" "$@"
}

assert_status() {
  local expected="$1"
  local label="$2"
  shift 2
  local actual
  actual="$(request_capture "$@")"
  [ "$actual" = "$expected" ] || fail "$label returned HTTP $actual; expected $expected"
}

assert_session_json() {
  local expected_role="$1"
  local expected_email="$2"
  if ! python3 - "$BODY_FILE" "$expected_role" "$expected_email" <<'PY'
import json
import sys

path, role, email = sys.argv[1:4]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

data = payload.get("data", {})
user = data.get("user", {})
ok = (
    payload.get("ok") is True
    and user.get("role") == role
    and user.get("email") == email
    and user.get("status") == "ACTIVE"
)
if not ok:
    raise SystemExit(f"session assertion failed: {payload!r}")
PY
  then
    fail "session payload did not match $expected_role/$expected_email"
  fi
}

assert_login_json() {
  local expected_role="$1"
  local expected_email="$2"
  if ! python3 - "$BODY_FILE" "$expected_role" "$expected_email" <<'PY'
import json
import sys

path, role, email = sys.argv[1:4]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

def contains_session_token(value):
    if isinstance(value, dict):
        return "sessionToken" in value or any(contains_session_token(v) for v in value.values())
    if isinstance(value, list):
        return any(contains_session_token(v) for v in value)
    return False

data = payload.get("data", {})
user = data.get("user", {})
ok = (
    payload.get("ok") is True
    and user.get("role") == role
    and user.get("email") == email
    and not contains_session_token(payload)
)
if not ok:
    raise SystemExit(f"login assertion failed: {payload!r}")
PY
  then
    fail "login payload did not match $expected_role/$expected_email or leaked a session token"
  fi
}

extract_session_cookie() {
  local token
  token="$(tr -d '\r' < "$HEADER_FILE" | grep -i '^set-cookie: mes_session=' | head -n 1 | sed -E 's/^[Ss]et-[Cc]ookie: mes_session=([^;]+).*/\1/')"
  [ -n "$token" ] || fail "login did not emit the HttpOnly mes_session cookie"
  printf '%s' "$token"
}

login() {
  local email="$1"
  local password="$2"
  local role="$3"
  : >"$HEADER_FILE"
  local status
  status="$(curl --silent --show-error --max-time 10 \
    --dump-header "$HEADER_FILE" \
    --output "$BODY_FILE" \
    --write-out "%{http_code}" \
    -X POST "$BASE_URL/api/v1/auth/login" \
    -H "Origin: $BASE_URL" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"$email\",\"password\":\"$password\"}")"
  [ "$status" = "200" ] || fail "$role login returned HTTP $status; expected 200"
  assert_login_json "$role" "$email"
  extract_session_cookie
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
  [ "$live_status" = "200" ] && break
  sleep 0.5
done
[ "$live_status" = "200" ] || fail "standalone server did not become live"

CURRENT_STAGE="admin-login"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "ADMIN")"

CURRENT_STAGE="admin-session"
assert_status 200 "admin /auth/me" \
  -H "Cookie: mes_session=$ADMIN_TOKEN" \
  "$BASE_URL/api/v1/auth/me"
assert_session_json "ADMIN" "$ADMIN_EMAIL"

CURRENT_STAGE="admin-access"
assert_status 200 "admin residents list" \
  -H "Cookie: mes_session=$ADMIN_TOKEN" \
  "$BASE_URL/api/v1/admin/residents?limit=5"

CURRENT_STAGE="admin-resident-boundary"
assert_status 403 "admin resident-only meals endpoint" \
  -H "Cookie: mes_session=$ADMIN_TOKEN" \
  "$BASE_URL/api/v1/meals"

CURRENT_STAGE="resident-login"
RESIDENT_TOKEN="$(login "$RESIDENT_EMAIL" "$RESIDENT_PASSWORD" "RESIDENT")"

CURRENT_STAGE="resident-session"
assert_status 200 "resident /auth/me" \
  -H "Cookie: mes_session=$RESIDENT_TOKEN" \
  "$BASE_URL/api/v1/auth/me"
assert_session_json "RESIDENT" "$RESIDENT_EMAIL"

CURRENT_STAGE="resident-access"
assert_status 200 "resident meals list" \
  -H "Cookie: mes_session=$RESIDENT_TOKEN" \
  "$BASE_URL/api/v1/meals"

CURRENT_STAGE="resident-admin-boundary"
assert_status 403 "resident admin residents endpoint" \
  -H "Cookie: mes_session=$RESIDENT_TOKEN" \
  "$BASE_URL/api/v1/admin/residents?limit=5"

CURRENT_STAGE="resident-logout"
assert_status 200 "resident logout" \
  -X POST "$BASE_URL/api/v1/auth/logout" \
  -H "Origin: $BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Cookie: mes_session=$RESIDENT_TOKEN"

CURRENT_STAGE="resident-session-revoked"
assert_status 401 "resident session after logout" \
  -H "Cookie: mes_session=$RESIDENT_TOKEN" \
  "$BASE_URL/api/v1/auth/me"

CURRENT_STAGE="complete"
echo "seeded Admin + Resident production auth smoke passed"
