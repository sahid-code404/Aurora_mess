-- Phase 67 — Final State Contract Closure
-- FormulaDefinition advertised archive state, but no runtime transition has ever
-- archived/restored formula definitions. Preserve provenance for any externally
-- mutated legacy marker, then collapse the model to the lifecycle actually used:
-- a definition exists and immutable FormulaVersions carry temporal history.

INSERT INTO "AuditEvent" (
  "id",
  "institutionId",
  "actorUserId",
  "actorRole",
  "action",
  "entityType",
  "entityId",
  "reason",
  "beforeSummary",
  "afterSummary",
  "metadataJson",
  "requestId",
  "occurredAt"
)
SELECT
  'phase67_formula_' || md5(fd."id" || clock_timestamp()::text),
  fd."institutionId",
  NULL,
  'SYSTEM',
  'FORMULA_DEFINITION_STATE_NORMALIZED',
  'FORMULA_DEFINITION',
  fd."id",
  'Removed legacy FormulaDefinition archive markers that had no supported runtime transition.',
  'status=' || COALESCE(fd."status", 'NULL') || '; archivedAt=' || COALESCE(fd."archivedAt"::text, 'NULL'),
  'Definition retained; FormulaVersion effective windows remain authoritative.',
  json_build_object('phase', 67, 'outputVariableKey', fd."outputVariableKey")::text,
  'migration-phase67-' || fd."id",
  NOW()
FROM "FormulaDefinition" fd
WHERE fd."status" IS DISTINCT FROM 'ACTIVE'
   OR fd."archivedAt" IS NOT NULL;

ALTER TABLE "FormulaDefinition"
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "archivedAt";
