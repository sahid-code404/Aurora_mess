# BoardOps Production Runbook

This runbook covers the repository's actual production runtime: Next.js standalone, PostgreSQL, Caddy/reverse-proxy headers, and private filesystem proof storage. It does not replace managed PostgreSQL point-in-time recovery, encrypted off-site backups, host monitoring, or infrastructure-provider procedures.

## Required production configuration

Set these outside Git. Do not commit real values.

- `DATABASE_URL`: PostgreSQL only.
- `SESSION_SECRET`: long random deployment secret.
- `UPLOAD_STORAGE_DIR`: persistent private volume for payment proofs/receipts. It must survive application deploys and must not be directly web-served.
- `ENABLE_PREVIEW_BEARER_AUTH`: leave unset or `0` in production.
- `API_REQUEST_LOGGING`: normally `1`. Production defaults to request JSON logs when unset.
- `PRISMA_LOG_QUERIES`: normally `0`. Enable only during controlled diagnostics.
- `LOG_ERROR_STACKS`: normally `0`; enable temporarily only when needed.

## Deployment sequence

1. Confirm a recent paired backup exists. Before schema-changing deploys, take a fresh backup with `ops/backup-boardops.sh`.
2. Install dependencies from the lockfile: `bun install --frozen-lockfile`.
3. Generate and validate Prisma: `bunx prisma generate && bunx prisma validate`.
4. Apply committed migrations: `bunx prisma migrate deploy`.
5. Confirm migration state: `bunx prisma migrate status`.
6. Build the production standalone artifact: `bun run build`.
7. Start BoardOps with the real runtime environment. The repository startup path must receive an external PostgreSQL `DATABASE_URL`.
8. Verify process health: `GET /api/v1/health/live` must return HTTP 200 with a healthy envelope.
9. Verify dependency readiness: `GET /api/v1/health/ready` must return HTTP 200 and report PostgreSQL ready.
10. Verify one Admin and one Resident sign-in/use case in the deployed environment before declaring the release complete.

Never use `prisma db push` or a SQLite/file database as a production migration mechanism.

## Private upload storage

`StoredFile` rows hold metadata and SHA-256 checksums; proof bytes live under `UPLOAD_STORAGE_DIR`. A database-only backup is therefore incomplete.

For a single-host deployment, use a persistent mounted volume such as `/var/lib/boardops/uploads`. The application process needs read/write access, while the reverse proxy must not expose this directory directly.

Horizontal application replicas can share PostgreSQL rate-limit counters, but all replicas also need access to the same uploaded-file bytes. Before active-active multi-host deployment, use a shared private volume or replace the filesystem transport with private object storage.

## Backups

Create a paired PostgreSQL + uploads backup:

```bash
BOARDOPS_BACKUP_DIR=/var/backups/boardops \
UPLOAD_STORAGE_DIR=/var/lib/boardops/uploads \
bash ops/backup-boardops.sh
```

The script creates a permission-restricted `boardops-backup-<UTC>.tar.gz` containing:

- PostgreSQL custom-format dump;
- private uploads archive;
- metadata including the Git commit when available;
- SHA-256 checksums.

The script validates both component archives before publishing the final backup file and never writes `DATABASE_URL` into the backup.

Recommended operating policy: take backups at least daily and immediately before production migrations/deployments. Copy backups to encrypted off-host storage with a retention policy appropriate for the deployment. For stronger recovery objectives, also enable managed PostgreSQL point-in-time recovery where available.

## Restore

A restore replaces the target database. Test restoration periodically in an isolated staging database and volume; do not make an incident the first restore rehearsal.

1. Stop BoardOps so no requests can write during recovery.
2. Point `DATABASE_URL` to the intended PostgreSQL target and `UPLOAD_STORAGE_DIR` to the intended private volume.
3. Verify the backup archive location.
4. Run the guarded restore:

```bash
BOARDOPS_RESTORE_CONFIRM=RESTORE_BOARDOPS \
UPLOAD_STORAGE_DIR=/var/lib/boardops/uploads \
bash ops/restore-boardops.sh /var/backups/boardops/boardops-backup-YYYYMMDDTHHMMSSZ.tar.gz
```

Before touching PostgreSQL, the restore script verifies required files, all checksums, the backup format, the PostgreSQL dump, and the uploads archive. It stages uploaded bytes first. Existing uploaded bytes are moved to a timestamped `.pre-restore-*` directory rather than deleted.

After restore:

```bash
bunx prisma generate
bunx prisma migrate deploy
bunx prisma migrate status
```

Then restart BoardOps and verify:

- `/api/v1/health/live` is healthy;
- `/api/v1/health/ready` reports PostgreSQL ready;
- Admin and Resident authentication works;
- a representative historical bill/payment can be read;
- at least one stored proof/receipt opens correctly;
- ledger/reconciliation screens show no new integrity failure.

Keep the preserved pre-restore upload directory until recovery has been verified.

## Shared rate-limit maintenance

Rate-limit buckets are stored in PostgreSQL so all application replicas enforce the same policy. Raw IP/email-bearing bucket keys are never persisted; only SHA-256 digests are stored.

Prune expired rows periodically:

```bash
bun run maintenance:rate-limits
```

Running this daily is sufficient for the current windows. Cleanup is not part of normal request handling, so user latency does not depend on table pruning.

## Request correlation and logs

Every API response carries `X-Request-ID`. Error envelopes expose the same request ID. Production request logs are structured JSON and include the request ID, method, pathname, status, duration, auth mode, and opaque actor/institution IDs when available.

They intentionally exclude request bodies, query strings, cookies, bearer/session tokens, emails, IP addresses, and user-agent strings. When a user reports an API error, obtain the request ID and search server logs for the matching `api_request` / `api_unexpected_error` event.

Raw Prisma query logging is disabled by default. Do not enable it as normal production telemetry.

## Incident checks

For application errors:

1. record `X-Request-ID` / envelope request ID;
2. check the structured server event with that ID;
3. check `/api/v1/health/live` and `/api/v1/health/ready`;
4. check PostgreSQL availability and migration status;
5. confirm the persistent upload volume is mounted and writable if files are affected;
6. avoid editing posted financial history directly—use existing reversal/correction workflows.

## Known operational boundaries

- The repository provides verified logical PostgreSQL backups, not continuous PITR by itself.
- Uploaded proof bytes remain filesystem-backed; shared object storage/multi-host file transport is a future infrastructure change, not silently provided by this runbook.
- Content type/signature validation exists for uploads; a dedicated malware-scanning service is not currently implemented.
- `ENABLE_PREVIEW_BEARER_AUTH` is preview compatibility only and should remain disabled in production.
