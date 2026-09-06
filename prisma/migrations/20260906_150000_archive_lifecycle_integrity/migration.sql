-- Phase 66 — archive lifecycle integrity.
-- RuleDefinition.status advertised ARCHIVED even though the resolver never
-- honored it. Preserve any non-ACTIVE legacy marker in AuditEvent, then remove
-- the fake lifecycle field. Policy.status remains because ACTIVE/ARCHIVED is a
-- real access lifecycle used by registration/auth and Admin actions.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase66-rule-definition-state-' || "id",
  "institutionId",
  'SYSTEM',
  'RULE_DEFINITION_STATE_NORMALIZED',
  'RULE_DEFINITION',
  "id",
  CURRENT_TIMESTAMP,
  'Removed an unused RuleDefinition archive marker that runtime never enforced.',
  'status=' || COALESCE("status", 'null'),
  'status field removed; definition remains authoritative'
FROM "RuleDefinition"
WHERE "status" IS DISTINCT FROM 'ACTIVE'
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "RuleDefinition" DROP COLUMN IF EXISTS "status";
