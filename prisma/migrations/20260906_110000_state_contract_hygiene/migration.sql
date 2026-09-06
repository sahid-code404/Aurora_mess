-- Phase 62 — persisted state contract hygiene.
-- No business/history rows are deleted. Legacy dead labels are mapped onto
-- the live lifecycle before the unused upload scan marker is removed.

UPDATE "Expense"
SET "status" = 'PENDING'
WHERE "status" = 'DRAFT';

UPDATE "FormulaDefinition"
SET "status" = CASE WHEN "archivedAt" IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END
WHERE "status" = 'DRAFT';

UPDATE "FormulaVersion"
SET "status" = CASE WHEN "active" = TRUE THEN 'ACTIVE' ELSE 'HISTORICAL' END
WHERE "status" IN ('DRAFT', 'SCHEDULED');

ALTER TABLE "StoredFile" DROP COLUMN IF EXISTS "scanStatus";
