-- Phase 64 — make BillingPeriod persistence match the transactional billing lifecycle.
-- Runtime keeps status OPEN while generationState=CLOSING owns one transaction.
-- That CLOSING write is never committed by itself: success commits BILLED +
-- COMPLETED and failure rolls the transaction back. Therefore any non-canonical
-- row visible at deployment is legacy/stale state. Preserve evidence first.

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
    WHEN EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = "BillingPeriod"."id")
         AND "status" NOT IN ('OPEN', 'BILLED', 'REOPENED')
      THEN 'status=BILLED; generationState=COMPLETED'
    WHEN "status" = 'BILLED'
      THEN 'status=BILLED; generationState=COMPLETED'
    WHEN "status" = 'REOPENED'
      THEN 'status=REOPENED; generationState=null'
    ELSE 'status=OPEN; generationState=null'
  END
FROM "BillingPeriod"
WHERE "status" NOT IN ('OPEN', 'BILLED', 'REOPENED')
   OR ("status" = 'OPEN' AND "generationState" IS NOT NULL)
   OR ("status" = 'BILLED' AND "generationState" IS DISTINCT FROM 'COMPLETED')
   OR ("status" = 'REOPENED' AND "generationState" IS NOT NULL)
   OR "generationError" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- If a legacy/non-canonical period already owns generated bills, those bills
-- are the irreversible evidence. Recover the period to BILLED rather than
-- exposing the same month to generation again.
UPDATE "BillingPeriod" p
SET
  "status" = 'BILLED',
  "generationState" = 'COMPLETED',
  "closedAt" = COALESCE(p."closedAt", p."billedAt", CURRENT_TIMESTAMP),
  "billedAt" = COALESCE(p."billedAt", p."closedAt", CURRENT_TIMESTAMP)
WHERE p."status" NOT IN ('OPEN', 'BILLED', 'REOPENED')
  AND EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = p."id");

-- Invalid/legacy period states without generated bills are safe to return to
-- OPEN. At migration time no application transaction can legitimately own the
-- transient CLOSING claim.
UPDATE "BillingPeriod" p
SET "status" = 'OPEN', "generationState" = NULL
WHERE p."status" NOT IN ('OPEN', 'BILLED', 'REOPENED')
  AND NOT EXISTS (SELECT 1 FROM "Bill" b WHERE b."billingPeriodId" = p."id");

-- Canonical committed state by period lifecycle.
UPDATE "BillingPeriod" SET "generationState" = NULL WHERE "status" = 'OPEN';
UPDATE "BillingPeriod" SET "generationState" = 'COMPLETED' WHERE "status" = 'BILLED';
UPDATE "BillingPeriod" SET "generationState" = NULL WHERE "status" = 'REOPENED';

-- No runtime path records a durable error: failed generation rolls back the
-- transaction. Legacy error text was captured in the audit event above.
ALTER TABLE "BillingPeriod" DROP COLUMN IF EXISTS "generationError";
