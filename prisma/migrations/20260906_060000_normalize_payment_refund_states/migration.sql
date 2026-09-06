-- Refund Center is resident-level pooled credit. Payment rows therefore remain
-- in their own review lifecycle; legacy refund-labelled rows are normalized to
-- APPROVED so settlement, billing and funds providers use one authoritative
-- payment-state vocabulary.
UPDATE "Payment"
SET "status" = 'APPROVED'
WHERE "status" IN ('REFUNDED', 'PARTIALLY_REFUNDED');
