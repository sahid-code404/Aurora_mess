-- Phase 59 — Calendar event temporal lifecycle integrity.
-- Calendar events are retained after cancellation so lazy meal locking can
-- reconstruct whether a meal-disabling event was active at the meal lock boundary.
ALTER TABLE "CalendarEvent"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD COLUMN "cancelReason" TEXT;

CREATE INDEX "CalendarEvent_institutionId_cancelledAt_startDate_idx"
  ON "CalendarEvent"("institutionId", "cancelledAt", "startDate");
