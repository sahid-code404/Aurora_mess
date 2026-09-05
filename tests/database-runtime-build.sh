#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# Build-time guard: an absent DATABASE_URL is allowed because builds must not
# touch production data, but no SQLite artifact may be created or copied.
EMPTY_BUILD="$TEST_ROOT/empty-build"
mkdir -p "$EMPTY_BUILD"
env -u DATABASE_URL BUILD_DIR="$EMPTY_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"
test ! -e "$EMPTY_BUILD/db/custom.db"

# A PostgreSQL URL is accepted and still produces no embedded database.
PG_BUILD="$TEST_ROOT/postgres-build"
mkdir -p "$PG_BUILD"
DATABASE_URL="postgresql://boardops:test@db.example.test:5432/boardops" BUILD_DIR="$PG_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"
test ! -e "$PG_BUILD/db/custom.db"

# File/SQLite URLs are rejected at build time.
SQLITE_BUILD="$TEST_ROOT/sqlite-build"
mkdir -p "$SQLITE_BUILD"
if DATABASE_URL="file:$SQLITE_BUILD/custom.db" BUILD_DIR="$SQLITE_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null 2>&1; then
    echo "expected file-based DATABASE_URL to be rejected" >&2
    exit 1
fi

# A legacy DB already present in the package directory is rejected even when a
# valid PostgreSQL URL is configured.
TAINTED_BUILD="$TEST_ROOT/tainted-build"
mkdir -p "$TAINTED_BUILD/db"
printf 'legacy-sqlite-data\n' >"$TAINTED_BUILD/db/custom.db"
if DATABASE_URL="postgres://boardops:test@db.example.test:5432/boardops" BUILD_DIR="$TAINTED_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null 2>&1; then
    echo "expected embedded legacy database to be rejected" >&2
    exit 1
fi

# Runtime startup must also fail closed without PostgreSQL. The script validates
# DATABASE_URL before attempting to launch Next.js or Caddy.
if env -u DATABASE_URL sh "$SCRIPT_DIR/start.sh" >/dev/null 2>&1; then
    echo "expected runtime without DATABASE_URL to fail" >&2
    exit 1
fi

if DATABASE_URL="file:/app/db/custom.db" sh "$SCRIPT_DIR/start.sh" >/dev/null 2>&1; then
    echo "expected runtime SQLite DATABASE_URL to fail" >&2
    exit 1
fi

# With PostgreSQL configured, allow the script to reach its normal Caddy exec.
# A fake caddy binary makes the test deterministic without starting services.
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/caddy" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$FAKE_BIN/caddy"
PATH="$FAKE_BIN:$PATH" DATABASE_URL="postgresql://boardops:test@db.example.test:5432/boardops" \
    sh "$SCRIPT_DIR/start.sh" >/dev/null

echo "PostgreSQL deployment runtime guard tests passed"
