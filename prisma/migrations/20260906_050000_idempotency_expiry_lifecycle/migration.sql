-- Phase 29 — Idempotency expiry lifecycle
--
-- IdempotencyRecord owns the time-bounded uniqueness lifecycle. Payment kept a
-- second permanent UNIQUE constraint on the same client key, which prevented a
-- legitimately expired key from ever being reused for a later payment.

DROP INDEX IF EXISTS "Payment_idempotencyKey_key";
CREATE INDEX IF NOT EXISTS "Payment_idempotencyKey_idx" ON "Payment"("idempotencyKey");

-- Expiry is now enforced by the claim path and this index keeps future bounded
-- cleanup / expiry maintenance efficient without scanning the whole table.
CREATE INDEX IF NOT EXISTS "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
