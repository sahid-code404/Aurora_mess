-- Phase 65 — persisted RuleVersion state contract integrity.
-- Runtime has never scheduled rule activation. Preserve any legacy row as a
-- draft candidate instead of pretending a scheduler will activate it.

INSERT INTO "AuditEvent" (
  "id", "institutionId", "actorRole", "action", "entityType", "entityId",
  "occurredAt", "reason", "beforeSummary", "afterSummary"
)
SELECT
  'phase65-rule-state-' || rv."id",
  rd."institutionId",
  'SYSTEM',
  'RULE_VERSION_STATE_NORMALIZED',
  'RULE_VERSION',
  rv."id",
  CURRENT_TIMESTAMP,
  'Normalized an unreachable SCHEDULED rule state; rule scheduling is not implemented.',
  'status=SCHEDULED',
  'status=DRAFT'
FROM "RuleVersion" rv
JOIN "RuleDefinition" rd ON rd."id" = rv."ruleDefinitionId"
WHERE rv."status" = 'SCHEDULED'
ON CONFLICT ("id") DO NOTHING;

UPDATE "RuleVersion"
SET "status" = 'DRAFT'
WHERE "status" = 'SCHEDULED';
