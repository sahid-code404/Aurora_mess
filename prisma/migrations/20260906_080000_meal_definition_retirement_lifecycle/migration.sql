-- Phase 46 — Meal-definition retirement lifecycle.
-- Cancellation provenance is persisted on the request itself; audit remains
-- append-only context, not the only source of lifecycle truth.
ALTER TABLE "DeletionRequest"
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3);

CREATE INDEX "DeletionRequest_institutionId_entityType_status_scheduledFor_idx"
  ON "DeletionRequest"("institutionId", "entityType", "status", "scheduledFor");

-- Historical meal deletion requests were created as QUEUED even though they
-- already had a concrete scheduledFor timestamp. Normalize them to the real
-- persisted state and immediately enforce the promised generation stop.
UPDATE "DeletionRequest"
SET "status" = 'SCHEDULED'
WHERE "entityType" = 'MEAL_DEFINITION'
  AND "status" = 'QUEUED'
  AND "scheduledFor" IS NOT NULL;

UPDATE "MealDefinition" AS md
SET
  "archivedAt" = COALESCE(md."archivedAt", md."deleteRequestedAt", NOW()),
  "active" = FALSE
WHERE md."deleteRequestedAt" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "DeletionRequest" AS dr
    WHERE dr."institutionId" = md."institutionId"
      AND dr."entityType" = 'MEAL_DEFINITION'
      AND dr."entityId" = md."id"
      AND dr."status" IN ('QUEUED', 'SCHEDULED', 'BLOCKED')
  );
