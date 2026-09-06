-- Phase 64 — make BillingPeriod persistence match the transactional billing lifecycle.
-- Runtime keeps status OPEN while generationState=CLOSING owns the transaction.
-- A failed run rolls back, so persisted CLOSING/GENERATING/FAILED on an OPEN
-- period can only be legacy/stale state after deployment. Preserve evidence in
-- AuditEvent before normalizing it.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase64-billing-state-' || "id",
  "institutionId",
  'SYSTEM',
  'BILLING_GENERATION_STATE_NORMALIZED',
  'BILLING_PERIOD',
  "id",
  CURRENT_TIMESTAMP,
  'Normalized a legacy billing period/generation state that cannot survive the current transactional lifecycle.',
  'status=' || COALESCE("status", 'null') || '; generationState=' || COALESCE("generationState", 'null') || '; generationError=' || COALESCE("generationError", 'null'),
  CASE
    WHEN "status" = 'CLOSING' AND EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = "BillingPeriod"."id")
      THEN 'status=BILLED; generationState=COMPLETED'
    WHEN "status" = 'BILLED'
      THEN 'status=BILLED; generationState=COMPLETED'
    WHEN "status" = 'REOPENED'
      THEN 'status=REOPENED; generationState=null'
    ELSE 'status=OPEN; generationState=null'
  END
FROM "BillingPeriod"
WHERE "status" = 'CLOSING'
   OR "generationState" IN ('GENERATING', 'FAILED')
   OR ("status" = 'OPEN' AND "generationState" = 'CLOSING')
   OR "generationError" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "BillingPeriod" p
SET
  "status" = 'BILLED',
  "generationState" = 'COMPLETED',
  "closedAt" = COALESCE(p."closedAt", p."billedAt", CURRENT_TIMESTAMP),
  "billedAt" = COALESCE(p."billedAt", p."closedAt", CURRENT_TIMESTAMP)
WHERE p."status" = 'CLOSING'
  AND EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = p."id");

UPDATE "BillingPeriod"
SET
  "status" = CASE WHEN "status" = 'CLOSING' THEN 'OPEN' ELSE "status" END,
  "generationState" = CASE
    WHEN "status" = 'BILLED' THEN 'COMPLETED'
    WHEN "status" = 'REOPENED' THEN NULL
    ELSE NULL
  END
WHERE "status" = 'CLOSING'
   OR "generationState" IN ('CLOSING', 'GENERATING', 'FAILED')
   OR "generationError" IS NOT NULL;

UPDATE "BillingPeriod" SET "generationState" = 'COMPLETED' WHERE "status" = 'BILLED';
UPDATE "BillingPeriod" SET "generationState" = NULL WHERE "status" = 'REOPENED';

ALTER TABLE "BillingPeriod" DROP COLUMN IF EXISTS "generationError";
