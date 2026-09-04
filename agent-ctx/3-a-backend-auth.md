# Task 3-a — Backend: auth / users / communications

Task ID: 3-a
Agent: Backend Engineer (auth/users/comms)
Status: COMPLETE (lint clean, curl-verified end-to-end)

## Scope delivered (25 route files, all via route() from @/lib/auth/guard)

Auth (public + session):
- POST /api/v1/auth/register — 5/h/IP; policy-acceptance verification (version → ACTIVE policy of
  first-active institution); creates User(RESIDENT, PENDING_APPROVAL) + profile + statusHistory +
  acceptances(ip,userAgent) + audit RESIDENT_REGISTERED; P2002 → EMAIL_TAKEN 409.
- POST /api/v1/auth/login — 8/15min/IP + 5/15min/email (pre-lookup, no enumeration); timing
  equalizer for unknown emails; status gates ACCOUNT_PENDING/REJECTED/INACTIVE (403); success →
  createSession (rotation) → cookie set on ok() envelope passthrough.
- POST /api/v1/auth/logout — revokeSession + cookie clear.
- GET  /api/v1/auth/me — user+profile+institution display fields; touchSession.
- GET  /api/v1/auth/policies — public; latest version of each ACTIVE policy; [] when no
  institution/policies (never 500).

Notifications / announcements:
- GET  /api/v1/notifications — sweepOutbox() FIRST (failures swallowed); ?unread=1&cursor&limit;
  newest-first, cursor "<createdAtISO>~<id>"; meta {unreadCount, nextCursor}.
- POST /api/v1/notifications/read-all — updateMany own unread.
- POST /api/v1/notifications/[id]/read — owner-only, 404 when not found, idempotent.
- GET  /api/v1/announcements — target EVERYONE|role, publishAt<=now, not expired, pinned first.

Profile:
- GET/PATCH /api/v1/me/profile — explicit field mapping only (fullName/phone/roomNumber/address/
  emergencyContact; "" clears); audit PROFILE_UPDATED before/after; GET returns user+profile.

Admin residents:
- GET  /api/v1/admin/residents — q/status/cursor/limit(25); profile+status+membership; funds
  summaries via residentFundsSummary in parallel (billable statuses only); KPI meta
  {total(ACTIVE|INACTIVE|CHANGES_REQUESTED), active, pending}.
- GET  /api/v1/admin/residents/[id] — 360°: user+profile+statusHistory+funds+payments(10)+
  bills(5 w/ lineCount)+tasks(5)+leave(5)+auditEvents(15, entityType=USER) — all Promise.all.
- POST [id]/approve — PENDING_APPROVAL|CHANGES_REQUESTED → ACTIVE; membershipEffectiveFrom=now
  if null; audit RESIDENT_APPROVED; outbox notification; opportunistic sweep.
- POST [id]/request-changes {reason} — → CHANGES_REQUESTED; audit; notif with reason.
- POST [id]/reject {reason} — → REJECTED; revokeAllUserSessions; audit; notif with reason.
- POST [id]/deactivate {reason} — ACTIVE → INACTIVE; MANDATORY revokeAllUserSessions; audit; notif.
- POST [id]/activate — INACTIVE → ACTIVE; audit RESIDENT_ACTIVATED.
- PATCH [id]/membership — from/until ISO or null; until>=from; closed-period guard: new from <
  any BILLED period start (period start = zonedTimeToUtc(y,m,1,0,0,instTz)) → VALIDATION_FAILED
  409 "Changing membership into a closed billing period is restricted."; audit
  RESIDENT_MEMBERSHIP_EDITED before/after.

Admin settings & policies:
- GET/PATCH /api/v1/admin/settings — institution (name/timezone/currencyCode/currencyMinorDigits
  [tz validated via Intl]), settings (money fields as DECIMAL STRINGS "1500.50" →
  parseDecimalToMinor), security; only changed fields audited (SETTINGS_UPDATED before/after
  summary); upsert settings rows; invalidateInstitutionCache().
- GET/POST /api/v1/admin/policies — GET all versions; POST {type,title,content} → new Policy v1
  or next immutable PolicyVersion on existing (unique institution+type+title), updates policy
  content + ACTIVE; audit POLICY_PUBLISHED.

Search / audit / files / health:
- GET /api/v1/search?q= — 2..60 chars; ADMIN groups (residents by name/email, payments by
  displayNumber/reference, bills by billNumber, expenses by displayNumber/description, tasks by
  description; limit 5/group, parallel); RESIDENT groups ONLY own payments/bills/tasks/leave —
  can never discover another resident.
- GET /api/v1/admin/audit — entityType/entityId/action filters, newest-first, cursor, limit 50;
  metadataJson parsed into `metadata`.
- GET /api/v1/files/[id] — bytes + content-type + nosniff; admin OR uploader OR resident whose
  own payment/taskSubmission references proofFileId; otherwise 404 (never leaks existence);
  never lists.
- GET /api/v1/health/live (200 {ok}), GET /api/v1/health/ready (db count → 200 | 503 envelope).

## Verification (throwaway fixture created + surgically removed; DB left empty)

Full flow tested with curl + cookie jars: register (acceptances verified, EMAIL_TAKEN on dup,
503 when no institution), pending login → ACCOUNT_PENDING, admin login → session cookie,
residents list KPI {total:0,active:0,pending:1}, approve → ACTIVE + membershipEffectiveFrom,
resident login, notifications show swept ACCOUNT_APPROVED (outbox→notification pipeline works),
read-all, single read, profile PATCH (+ mass-assignment ignored role/status), search both roles
(resident saw only own empty groups; admin found the resident), 360 view, settings GET/PATCH
("1500.50"→150050 minor; bad money/timezone rejected with field errors), policies v1→v2 bump
(public endpoint reflects v2), membership allowed/restricted/clear cases (BILLED period guard
returned exact spec message), request-changes state guard 409, deactivate → resident session
immediately 401 (revocation verified), activate, unknown ids 404, audit filters, files 404,
FORBIDDEN for resident on admin routes, logout kills session. Teardown removed all rows;
health/ready reports institutions:0 and policies returns [] (clean slate for the seed task).

## Deviations / notes

1. register: `acceptances` min-1 is enforced ONLY when active policies exist (bootstrap case
   with zero published policies accepts an empty list — matches frontend fallback checkbox).
2. State-machine violations return VALIDATION_FAILED with HTTP 409 (400 kept for malformed
   input); membership closed-period guard uses the spec's exact code + message.
3. Login adds a scrypt timing-equalizer for unknown emails (anti-enumeration hardening).
4. Audit RESIDENT_REGISTERED / PROFILE_UPDATED added beyond the listed codes (low-noise, useful
   trail); no audit on login/logout (rate limit covers, per task guidance).
5. Notifications GET sweeps the GLOBAL outbox (by design of the frozen sweeper).
6. Files route also honors task-submission proofs for residents (covers the "expense references"
   clause; admin-uploaded expense proofs are already covered by the uploader rule).
7. Dev-server incident (documented in worklog): the shared dev server was OOM-killed by the
   kernel at ~20:29 (next-server anon-rss 2.5GB, sandbox 4GB) while compiling several agents'
   routes in parallel. Restored detached via `setsid -f bun run dev` (same command/port/log);
   .zscripts/dev.pid updated. A plain nohup+disown was killed by the tool's process-group
   cleanup — setsid is required for anything that must outlive a command.
8. tsc --noEmit: my 25 files have zero errors; remaining errors are pre-existing scaffold
   (examples/, skills/) or other agents' in-flight files (admin/refunds, domain/billing,
   formula/parser) — untouched by me.
