-- Refund corrections are append-only financial history. A completed refund is
-- never deleted or edited back into an active state; voiding records who/when/
-- why and, for cash payouts, links the compensating reversal journal.
ALTER TABLE "Refund"
  ADD COLUMN "reversalJournalId" TEXT,
  ADD COLUMN "voidReason" TEXT,
  ADD COLUMN "voidedByUserId" TEXT,
  ADD COLUMN "voidedAt" TIMESTAMP(3);

CREATE INDEX "Refund_institutionId_residentId_status_idx"
  ON "Refund"("institutionId", "residentId", "status");
