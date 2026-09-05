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
3. Create a future leave request as Resident. While it is `PENDING`, cancel it from **My leave requests** and confirm it becomes `CANCELLED` without changing any meals. Create another selected-meal leave and approve it as Admin; confirm only selected meals change. Approved/rejected leave is historical and cannot be cancelled.
4. Create a selected-meal calendar disable as Admin; confirm unaffected meals stay available.
5. Verify guest meals remain separate from resident meal totals.
6. Exercise Normal Task and Market Task flows separately.
7. Submit a Resident payment and, while it is still `PENDING`, open its details and choose **Withdraw submission**. Confirm it moves to `VOIDED`, disappears from the Admin pending queue, stays in both histories, and never changes approved balance or bill settlement. Submit a second payment and approve it as Admin to verify the normal review path still works.
8. After a bill exists, create an overpayment and open **Admin → Payments → Refund Center**. Test a partial cash payout, then carry forward the remaining excess. The resident should disappear from Refund Center for that bill cycle while the carried-forward credit remains available for a future bill.
9. Review Variables + Formula Engine on the same Admin page and use preview before activation.
10. Check previous billed month history remains unchanged while current month is open.
11. Test logout and verify the old session cannot access authenticated APIs.

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

## Production Refund Center smoke

The Refund Center has a separate production-server acceptance because it intentionally mutates post-billing money state:

```bash
BOARDOPS_REFUND_SMOKE_DIAGNOSTIC_DIR=refund-smoke-diagnostics \
  bash tests/seeded-refund-center-smoke.sh
```

It verifies the complete post-billing excess lifecycle through authenticated HTTP APIs:

- a large resident payment is still `PENDING` until Admin approval;
- after approval, genuine excess appears in `/api/v1/admin/refunds/eligible` with latest-bill provenance;
- a partial `ISSUE_REFUND` completes, posts a refund journal and reduces the Refund Center amount exactly once;
- the resident stays in Refund Center with the precise remaining excess after a partial payout;
- partial `CARRY_FORWARD` is rejected because carry-forward must resolve the whole current-cycle remainder;
- full carry-forward completes without a cash journal and preserves the remaining credit for a future bill;
- the resident then disappears from Refund Center for the current bill cycle;
- a second refund decision is rejected until a newer bill exists;
- both Admin and Resident refund histories show the payout and carry-forward records.

Like every seeded smoke, this must run only against disposable test data.

## Production leave-cancellation smoke

Pending leave has its own production-server lifecycle acceptance:

```bash
BOARDOPS_LEAVE_SMOKE_DIAGNOSTIC_DIR=leave-smoke-diagnostics \
  bash tests/seeded-leave-cancel-smoke.sh
```

The test discovers a future unlocked meal through the Resident APIs and proves:

- a new Resident leave request starts as `PENDING` and appears in the Admin pending queue;
- a different Resident cannot cancel it;
- the owner can transition it from `PENDING` to `CANCELLED`;
- both Resident history and the Admin `CANCELLED` filter show the terminal state;
- a second cancellation is rejected;
- Admin approval after cancellation is rejected, so a reviewed/cancelled decision cannot be overwritten;
- creating and cancelling a pending leave does not alter any ResidentMeal state.

Only `PENDING` leave can be self-cancelled. `APPROVED` and `REJECTED` requests are retained as immutable review history; cancellation never acts as an un-approve operation.

## Production payment-withdrawal smoke

Pending Resident payments have their own production-server lifecycle acceptance:

```bash
BOARDOPS_PAYMENT_WITHDRAW_SMOKE_DIAGNOSTIC_DIR=payment-withdraw-smoke-diagnostics \
  bash tests/seeded-payment-withdrawal-smoke.sh
```

It verifies that:

- a submitted payment begins as `PENDING` and increases only the pending count;
- another Resident cannot withdraw the owner's payment;
- the owner can withdraw it before Admin review, producing a retained `VOIDED` history row;
- withdrawal returns the pending count to its baseline and does not change approved deposits;
- withdrawal does not populate Admin-review metadata or create ledger/bill-settlement effects;
- a second withdrawal is rejected;
- Admin approval of the already-withdrawn payment is rejected;
- the `VOIDED` record remains visible to both Resident and Admin history views.

Withdrawal is intentionally different from Admin voiding an **approved** payment. An approved payment has already entered the ledger and can only be voided by Admin through the existing reversal-journal workflow.

## CI acceptance guarantee

The CI pipeline runs the same development seed against PostgreSQL and builds the production standalone server. It then runs five seeded production gates:

1. **Authentication/authorization smoke** — successful Admin and Resident login, session-role verification, Admin/Resident API isolation, and logout/session revocation.
2. **Cross-role business-flow smoke** — guest separation/idempotency, selected-meal leave, selected-meal calendar disable, GENERAL vs MARKET task lifecycle, market-expense creation, payment submit/approve/idempotency, Formula Engine preview non-mutation, and historical-bill provenance stability.
3. **Refund Center lifecycle smoke** — post-billing overpayment discovery, partial cash payout, remaining-excess recalculation, whole-remainder carry-forward, current-cycle closure, and Admin/Resident history visibility.
4. **Leave cancellation lifecycle smoke** — ownership, pending-only cancellation, Admin queue/history visibility, terminal-state enforcement, and proof that cancelled pending leave never changes meal state.
5. **Payment withdrawal lifecycle smoke** — ownership, pending-only withdrawal, retained `VOIDED` history, Admin-review exclusion, pending-count restoration, and proof that a withdrawn pending payment never changes approved funds.

These gates run in addition to migrations, zero-warning lint, unit/integration tests, the PostgreSQL + uploads disaster-recovery drill, storage-integrity checks, production build and the standalone runtime smoke. CI uploads separate server/flow diagnostics when any production smoke fails.
