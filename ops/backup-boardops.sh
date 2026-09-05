#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "BoardOps backup failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not installed"
}

case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*) ;;
  *) fail "DATABASE_URL must be set to a PostgreSQL URL" ;;
esac

require_command pg_dump
require_command pg_restore
require_command tar
require_command sha256sum
require_command mktemp

BACKUP_ROOT="${BOARDOPS_BACKUP_DIR:-$PWD/backups}"
UPLOAD_DIR="${UPLOAD_STORAGE_DIR:-$PWD/uploads-storage}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_NAME="boardops-backup-${TIMESTAMP}.tar.gz"
FINAL_PATH="${BACKUP_ROOT%/}/${ARCHIVE_NAME}"
TMP_DIR="$(mktemp -d)"
PAYLOAD_DIR="$TMP_DIR/payload"
PARTIAL_PATH="${FINAL_PATH}.partial"

cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$PARTIAL_PATH"
}
trap cleanup EXIT

mkdir -p "$BACKUP_ROOT" "$PAYLOAD_DIR"

# PostgreSQL custom format preserves schema/data and is verifiable with pg_restore --list.
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$PAYLOAD_DIR/database.dump" \
  "$DATABASE_URL"
pg_restore --list "$PAYLOAD_DIR/database.dump" >/dev/null

# File bytes are a second authoritative recovery input because StoredFile rows
# contain only metadata/checksums. Always create an archive, even when empty.
if [ -d "$UPLOAD_DIR" ]; then
  tar -C "$UPLOAD_DIR" -czf "$PAYLOAD_DIR/uploads.tar.gz" .
else
  tar -czf "$PAYLOAD_DIR/uploads.tar.gz" --files-from /dev/null
fi
tar -tzf "$PAYLOAD_DIR/uploads.tar.gz" >/dev/null

GIT_COMMIT="unknown"
if command -v git >/dev/null 2>&1; then
  GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
fi

{
  printf 'format=boardops-backup-v1\n'
  printf 'created_at_utc=%s\n' "$TIMESTAMP"
  printf 'git_commit=%s\n' "$GIT_COMMIT"
  printf 'database_format=postgresql-custom\n'
  printf 'uploads_archive=uploads.tar.gz\n'
} >"$PAYLOAD_DIR/metadata.txt"

(
  cd "$PAYLOAD_DIR"
  sha256sum database.dump uploads.tar.gz metadata.txt > checksums.sha256
)

# Package only verified payload files. Credentials and DATABASE_URL are never written.
tar -C "$PAYLOAD_DIR" -czf "$PARTIAL_PATH" \
  metadata.txt checksums.sha256 database.dump uploads.tar.gz
mv "$PARTIAL_PATH" "$FINAL_PATH"
chmod 600 "$FINAL_PATH"

printf '%s\n' "$FINAL_PATH"
