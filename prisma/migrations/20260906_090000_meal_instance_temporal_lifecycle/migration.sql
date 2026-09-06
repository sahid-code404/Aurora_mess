-- Phase 48: align persisted MealInstance state with the actual temporal lifecycle.
ALTER TABLE "MealInstance" ALTER COLUMN "status" SET DEFAULT 'OPEN';

UPDATE "MealInstance"
SET
  "lockAt" = LEAST("cutoffAt", "serviceStartAt"),
  "status" = CASE
    WHEN CURRENT_TIMESTAMP >= "serviceEndAt" THEN 'COMPLETED'
    WHEN CURRENT_TIMESTAMP >= "serviceStartAt" THEN 'SERVICE_ACTIVE'
    WHEN CURRENT_TIMESTAMP >= LEAST("cutoffAt", "serviceStartAt") THEN 'LOCKED'
    ELSE 'OPEN'
  END
WHERE "status" <> 'CANCELLED';
