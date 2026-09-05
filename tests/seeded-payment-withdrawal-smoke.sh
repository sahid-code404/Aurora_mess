#!/usr/bin/env bash
set -euo pipefail

PORT="${BOARDOPS_PAYMENT_WITHDRAW_SMOKE_PORT:-3104}"
HOST="127.0.0.1"
BASE_URL="http://${HOST}:${PORT}"
SERVER_LOG="$(mktemp)"
FLOW_LOG="$(mktemp)"
SERVER_PID=""
CURRENT_STAGE="bootstrap"
DIAGNOSTIC_DIR="${BOARDOPS_PAYMENT_WITHDRAW_SMOKE_DIAGNOSTIC_DIR:-}"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_LOG" "$FLOW_LOG"
}
trap cleanup EXIT

fail() {
  local message="$*"
  if [ -n "$DIAGNOSTIC_DIR" ]; then
    mkdir -p "$DIAGNOSTIC_DIR"
    printf 'stage=%s\nmessage=%s\n' "$CURRENT_STAGE" "$message" >"$DIAGNOSTIC_DIR/failure.txt"
    cp "$SERVER_LOG" "$DIAGNOSTIC_DIR/server.log" 2>/dev/null || true
    cp "$FLOW_LOG" "$DIAGNOSTIC_DIR/flow.log" 2>/dev/null || true
  fi
  echo "seeded payment-withdrawal smoke failed ($CURRENT_STAGE): $message" >&2
  cat "$FLOW_LOG" >&2 || true
  cat "$SERVER_LOG" >&2 || true
  exit 1
}

case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*) ;;
  *) fail "DATABASE_URL must point to PostgreSQL" ;;
esac
[ -n "${SESSION_SECRET:-}" ] || fail "SESSION_SECRET is required"
[ -f ".next/standalone/server.js" ] || fail "production standalone server is missing"

export NODE_ENV=production
export PORT
export HOSTNAME="$HOST"
export ENABLE_PREVIEW_BEARER_AUTH=0
export BOARDOPS_PAYMENT_WITHDRAW_SMOKE_BASE_URL="$BASE_URL"

CURRENT_STAGE="server-start"
bun .next/standalone/server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

CURRENT_STAGE="liveness"
live=""
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "standalone server exited during startup"
  fi
  live="$(curl --silent --max-time 2 --output /dev/null --write-out "%{http_code}" "$BASE_URL/api/v1/health/live" 2>/dev/null || true)"
  [ "$live" = "200" ] && break
  sleep 0.5
done
[ "$live" = "200" ] || fail "standalone server did not become live"

CURRENT_STAGE="payment-withdrawal-lifecycle"
if ! python3 tests/seeded-payment-withdrawal-smoke.py >"$FLOW_LOG" 2>&1; then
  fail "payment withdrawal acceptance driver failed"
fi

CURRENT_STAGE="complete"
cat "$FLOW_LOG"
echo "seeded Resident pending-payment withdrawal smoke passed"
