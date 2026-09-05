#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "disaster recovery drill failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not installed"
}

case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*) ;;
  *) fail "DATABASE_URL must be PostgreSQL" ;;
esac

require_command psql
require_command pg_dump
require_command pg_restore
require_command sha256sum

# CI deliberately uses Prisma's common ?schema=public URL so the backup/restore
# scripts prove their libpq compatibility path. The drill's own psql checks use
# the equivalent CLI-safe URL only for test assertions.
PG_URL="${DATABASE_URL//\?schema=public&/?}"
PG_URL="${PG_URL//&schema=public/}"
PG_URL="${PG_URL//\?schema=public/}"

WORK_DIR="$(mktemp -d)"
UPLOAD_DIR="$WORK_DIR/uploads"
BACKUP_DIR="$WORK_DIR/backups"
ORIGINAL_FILE="$UPLOAD_DIR/recovery-marker.txt"
POST_BACKUP_FILE="$UPLOAD_DIR/post-backup-only.txt"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$UPLOAD_DIR" "$BACKUP_DIR"
printf 'original-proof-bytes\n' > "$ORIGINAL_FILE"
ORIGINAL_SHA="$(sha256sum "$ORIGINAL_FILE" | awk '{print $1}')"

KEY_ONE="$(printf 'boardops-phase15-original' | sha256sum | awk '{print $1}')"
KEY_TWO="$(printf 'boardops-phase15-post-backup' | sha256sum | awk '{print $1}')"

psql "$PG_URL" -v ON_ERROR_STOP=1 <<SQL
DELETE FROM "RateLimitBucket" WHERE "keyHash" IN ('$KEY_ONE', '$KEY_TWO');
INSERT INTO "RateLimitBucket" ("keyHash", "count", "resetAt", "updatedAt")
VALUES ('$KEY_ONE', 7, NOW() + INTERVAL '1 hour', NOW());
SQL

BACKUP_PATH="$(
  BOARDOPS_BACKUP_DIR="$BACKUP_DIR" \
  UPLOAD_STORAGE_DIR="$UPLOAD_DIR" \
  bash ops/backup-boardops.sh
)"
[ -f "$BACKUP_PATH" ] || fail "backup archive was not created"

# Deliberately mutate both recovery domains after the backup.
printf 'mutated-proof-bytes\n' > "$ORIGINAL_FILE"
printf 'must-disappear-after-restore\n' > "$POST_BACKUP_FILE"
psql "$PG_URL" -v ON_ERROR_STOP=1 <<SQL
UPDATE "RateLimitBucket" SET "count" = 99 WHERE "keyHash" = '$KEY_ONE';
INSERT INTO "RateLimitBucket" ("keyHash", "count", "resetAt", "updatedAt")
VALUES ('$KEY_TWO', 3, NOW() + INTERVAL '1 hour', NOW());
SQL

BOARDOPS_RESTORE_CONFIRM=RESTORE_BOARDOPS \
UPLOAD_STORAGE_DIR="$UPLOAD_DIR" \
bash ops/restore-boardops.sh "$BACKUP_PATH"

RESTORED_COUNT="$(psql "$PG_URL" -At -v ON_ERROR_STOP=1 -c "SELECT \"count\" FROM \"RateLimitBucket\" WHERE \"keyHash\" = '$KEY_ONE';")"
[ "$RESTORED_COUNT" = "7" ] || fail "database marker was not restored (got '$RESTORED_COUNT')"

POST_BACKUP_COUNT="$(psql "$PG_URL" -At -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM \"RateLimitBucket\" WHERE \"keyHash\" = '$KEY_TWO';")"
[ "$POST_BACKUP_COUNT" = "0" ] || fail "post-backup database state survived restore"

[ -f "$ORIGINAL_FILE" ] || fail "restored proof marker is missing"
RESTORED_SHA="$(sha256sum "$ORIGINAL_FILE" | awk '{print $1}')"
[ "$RESTORED_SHA" = "$ORIGINAL_SHA" ] || fail "restored proof bytes do not match the backup"
[ ! -e "$POST_BACKUP_FILE" ] || fail "post-backup upload state survived restore"

PREVIOUS_DIR_COUNT="$(find "$WORK_DIR" -maxdepth 1 -type d -name 'uploads.pre-restore-*' | wc -l | tr -d ' ')"
[ "$PREVIOUS_DIR_COUNT" = "1" ] || fail "pre-restore upload directory was not preserved exactly once"
PREVIOUS_DIR="$(find "$WORK_DIR" -maxdepth 1 -type d -name 'uploads.pre-restore-*' -print -quit)"
[ -f "$PREVIOUS_DIR/post-backup-only.txt" ] || fail "preserved pre-restore directory does not contain mutated uploads"

# The restored dump includes Prisma migration history; the schema must remain at
# the repository's committed migration head before later tests proceed.
bunx prisma migrate status >/dev/null

# Remove the drill marker so later integration tests start from normal state.
psql "$PG_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM \"RateLimitBucket\" WHERE \"keyHash\" = '$KEY_ONE';" >/dev/null

echo "disaster recovery drill passed"
