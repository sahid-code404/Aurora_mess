# BoardOps Acceptance Testing

This is the repository-supported local acceptance path for the current `main` build. It uses PostgreSQL and the deterministic development seed. **Never run the seed against a production database** because it intentionally wipes and recreates development data.

## Prerequisites

- Git
- Bun 1.3.x
- Docker (recommended for the disposable PostgreSQL test database)

## 1. Start a disposable PostgreSQL 17 database

```bash
docker rm -f boardops-test-db 2>/dev/null || true

docker run -d \
  --name boardops-test-db \
  -e POSTGRES_USER=boardops \
  -e POSTGRES_PASSWORD=boardops \
  -e POSTGRES_DB=boardops_test \
  -p 5432:5432 \
  postgres:17-alpine
```

Wait until PostgreSQL is ready:

```bash
docker exec boardops-test-db pg_isready -U boardops -d boardops_test
```

## 2. Configure the local BoardOps runtime

From the repository root:

```bash
export DATABASE_URL='postgresql://boardops:boardops@127.0.0.1:5432/boardops_test?schema=public'
export SESSION_SECRET='boardops-local-testing-secret-change-me'
export UPLOAD_STORAGE_DIR="$PWD/uploads-storage"
export ENABLE_PREVIEW_BEARER_AUTH=0
```

These values are for local testing only.

## 3. Install, migrate and seed

```bash
bun install --frozen-lockfile
bun run db:generate
bun run db:migrate:deploy
bun run db:seed:dev
```

The seed creates realistic current/previous-month data, meals, residents, payments, expenses, tasks, announcements and billing history.

## 4. Run the web app

Development UI testing:

```bash
bun run dev
```

Open:

```text
http://localhost:3000
```

For production-build testing instead:

```bash
bun run build
PORT=3000 HOSTNAME=127.0.0.1 bun .next/standalone/server.js
```

## Test accounts

### Admin

```text
Email:    admin@messtest.in
Password: Admin#12345
```

### Resident

```text
Email:    sahid@messtest.in
Password: Resident#12345
```

Additional active resident accounts use the same resident password:

```text
riya@messtest.in
arjun@messtest.in
meera@messtest.in
farhan@messtest.in
```

Pending-registration test account:

```text
newres@messtest.in
Password: Resident#12345
```

## Suggested acceptance flow

1. Sign in as Admin and review dashboard/residents.
2. Sign in as Resident and verify the meal calendar and current meal states.
3. Create a selected-meal leave request and approve it as Admin; confirm only selected meals change.
4. Create a selected-meal calendar disable as Admin; confirm unaffected meals stay available.
5. Verify guest meals remain separate from resident meal totals.
6. Exercise Normal Task and Market Task flows separately.
7. Submit/review payments and check that posted financial history remains auditable.
8. Review Variables + Formula Engine on the same Admin page and use preview before activation.
9. Check previous billed month history remains unchanged while current month is open.
10. Test logout and verify the old session cannot access authenticated APIs.

## Production business-flow smoke

After seeding and building the production standalone server, the repository can execute the cross-role flow directly:

```bash
BOARDOPS_BUSINESS_SMOKE_DIAGNOSTIC_DIR=business-smoke-diagnostics \
  bash tests/seeded-business-flow-smoke.sh
```

This test discovers the seeded resident, future unlocked meals, definition IDs and historical bill through authenticated HTTP APIs rather than reading Prisma directly. It then proves:

- guest booking is idempotent and does not change resident meal totals;
- selected-meal leave changes only the selected meal after Admin approval;
- selected-meal calendar disabling changes only the selected definition;
- GENERAL and MARKET_PURCHASE tasks remain separate workflows;
- market submission approval creates the expected approved expense and journal link;
- resident payment submission stays pending until Admin approval and idempotent retry does not double-credit;
- Formula Engine preview resolves live variables without mutating active formula definitions;
- immutable historical bill provenance remains unchanged while current operational flows execute.

The smoke mutates the disposable seeded database and therefore must not be pointed at a production database.

## CI acceptance guarantee

The CI pipeline runs the same development seed against PostgreSQL and builds the production standalone server. It then runs two seeded production gates:

1. **Authentication/authorization smoke** — successful Admin and Resident login, session-role verification, Admin/Resident API isolation, and logout/session revocation.
2. **Cross-role business-flow smoke** — guest separation/idempotency, selected-meal leave, selected-meal calendar disable, GENERAL vs MARKET task lifecycle, market-expense creation, payment submit/approve/idempotency, Formula Engine preview non-mutation, and historical-bill provenance stability.

These gates run in addition to migrations, zero-warning lint, unit/integration tests, the PostgreSQL + uploads disaster-recovery drill, storage-integrity checks, production build and the standalone runtime smoke. CI uploads separate server/flow diagnostics when any production smoke fails.
