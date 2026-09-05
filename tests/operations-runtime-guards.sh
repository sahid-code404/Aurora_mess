#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "operations runtime guard failed: $*" >&2
  exit 1
}

bash -n ops/backup-boardops.sh
bash -n ops/restore-boardops.sh

# Both tools must fail closed before invoking PostgreSQL utilities when the
# database transport is absent or invalid.
if env -u DATABASE_URL bash ops/backup-boardops.sh >/dev/null 2>&1; then
  fail "backup accepted a missing DATABASE_URL"
fi
if DATABASE_URL='file:/tmp/boardops.db' bash ops/backup-boardops.sh >/dev/null 2>&1; then
  fail "backup accepted a non-PostgreSQL DATABASE_URL"
fi

DUMMY_BACKUP="$(mktemp)"
trap 'rm -f "$DUMMY_BACKUP"' EXIT
if DATABASE_URL='postgresql://example.invalid/boardops' \
  bash ops/restore-boardops.sh "$DUMMY_BACKUP" >/dev/null 2>&1; then
  fail "restore ran without BOARDOPS_RESTORE_CONFIRM"
fi

if ! grep -q 'verify-storage-integrity.ts' ops/backup-boardops.sh; then
  fail "backup no longer runs the authoritative StoredFile integrity preflight"
fi
if ! grep -q "storage_integrity=verified" ops/backup-boardops.sh; then
  fail "backup metadata no longer records successful storage verification"
fi
if ! grep -q 'maintenance:storage-integrity' package.json; then
  fail "storage integrity maintenance command is missing"
fi

if ! grep -qx '/uploads-storage/' .gitignore; then
  fail "private default upload storage is not ignored by Git"
fi
if ! grep -qx '/backups/' .gitignore; then
  fail "local backup artifacts are not ignored by Git"
fi
if ! grep -q '^SESSION_SECRET=' .env.example; then
  fail ".env.example does not document SESSION_SECRET"
fi
if ! grep -q '^UPLOAD_STORAGE_DIR=' .env.example; then
  fail ".env.example does not document persistent upload storage"
fi

echo "operations runtime guards passed"
