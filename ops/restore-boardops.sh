#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "BoardOps restore failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not installed"
}

BACKUP_ARCHIVE="${1:-}"
[ -n "$BACKUP_ARCHIVE" ] || fail "usage: BOARDOPS_RESTORE_CONFIRM=RESTORE_BOARDOPS bash ops/restore-boardops.sh <backup.tar.gz>"
[ "${BOARDOPS_RESTORE_CONFIRM:-}" = "RESTORE_BOARDOPS" ] || \
  fail "set BOARDOPS_RESTORE_CONFIRM=RESTORE_BOARDOPS to acknowledge destructive database restore"

case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*) ;;
  *) fail "DATABASE_URL must be set to the PostgreSQL database that will be restored" ;;
esac

[ -f "$BACKUP_ARCHIVE" ] || fail "backup archive not found: $BACKUP_ARCHIVE"

require_command pg_restore
require_command tar
require_command sha256sum
require_command mktemp

UPLOAD_DIR="${UPLOAD_STORAGE_DIR:-$PWD/uploads-storage}"
case "$UPLOAD_DIR" in
  ""|"/") fail "UPLOAD_STORAGE_DIR must not be empty or /" ;;
esac

TMP_DIR="$(mktemp -d)"
PAYLOAD_DIR="$TMP_DIR/payload"
STAGED_UPLOADS="$TMP_DIR/restored-uploads"
PREVIOUS_UPLOADS=""

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$PAYLOAD_DIR" "$STAGED_UPLOADS"
tar -xzf "$BACKUP_ARCHIVE" -C "$PAYLOAD_DIR"

for required in metadata.txt checksums.sha256 database.dump uploads.tar.gz; do
  [ -f "$PAYLOAD_DIR/$required" ] || fail "backup is missing required file: $required"
done

(
  cd "$PAYLOAD_DIR"
  sha256sum -c checksums.sha256
) || fail "backup checksum verification failed"

grep -qx 'format=boardops-backup-v1' "$PAYLOAD_DIR/metadata.txt" || \
  fail "unsupported or invalid backup format"

pg_restore --list "$PAYLOAD_DIR/database.dump" >/dev/null || \
  fail "PostgreSQL dump is not readable"
tar -tzf "$PAYLOAD_DIR/uploads.tar.gz" >/dev/null || \
  fail "uploads archive is not readable"

# Stage all file bytes before touching the database so a malformed archive can
# never leave a successful DB restore paired with missing proof files.
tar -xzf "$PAYLOAD_DIR/uploads.tar.gz" -C "$STAGED_UPLOADS"

# The application must be stopped by the operator before this command. Restore
# the database atomically as far as pg_restore permits and stop on first error.
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --dbname="$DATABASE_URL" \
  "$PAYLOAD_DIR/database.dump"

UPLOAD_PARENT="$(dirname "$UPLOAD_DIR")"
mkdir -p "$UPLOAD_PARENT"
if [ -e "$UPLOAD_DIR" ]; then
  PREVIOUS_UPLOADS="${UPLOAD_DIR}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$UPLOAD_DIR" "$PREVIOUS_UPLOADS"
fi
mv "$STAGED_UPLOADS" "$UPLOAD_DIR"
chmod 700 "$UPLOAD_DIR" 2>/dev/null || true

printf 'BoardOps restore completed.\n'
if [ -n "$PREVIOUS_UPLOADS" ]; then
  printf 'Previous upload directory preserved at: %s\n' "$PREVIOUS_UPLOADS"
fi
printf 'Next: run prisma migrate deploy, restart BoardOps, then verify health/readiness and representative records.\n'
