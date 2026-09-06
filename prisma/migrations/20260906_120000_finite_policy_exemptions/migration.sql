-- Phase 63 — enforce the finite deficit-policy exemption contract.
-- Legacy open-ended exemptions are retained as history, audited, and ended
-- at migration time before the persistence column becomes NOT NULL.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase63-finite-' || "id",
  "institutionId",
  'SYSTEM',
  'POLICY_EXEMPTION_LEGACY_ENDED',
  'POLICY_EXEMPTION',
  "id",
  CURRENT_TIMESTAMP,
  'Legacy open-ended exemptions are invalid under the finite exemption lifecycle.',
  'legacy open-ended exemption',
  'ended during finite exemption migration'
FROM "PolicyExemption"
WHERE "expiresAt" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "PolicyExemption"
SET "expiresAt" = CURRENT_TIMESTAMP
WHERE "expiresAt" IS NULL;

ALTER TABLE "PolicyExemption" ALTER COLUMN "expiresAt" SET NOT NULL;
