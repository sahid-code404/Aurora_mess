-- Phase 27: concurrency-safe human-facing display-number allocation.
--
-- COUNT + 1 can hand the same candidate to concurrent requests. This small
-- counter table makes allocation a single PostgreSQL UPSERT per prefix/month.
-- nextValue always stores the next unallocated integer. Existing production
-- numbers are backfilled from their highest valid suffix so deployment cannot
-- reuse an already-issued identifier.

CREATE TABLE "DisplayNumberSequence" (
    "key" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisplayNumberSequence_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "DisplayNumberSequence_nextValue_check" CHECK ("nextValue" > 0)
);

INSERT INTO "DisplayNumberSequence" ("key", "nextValue", "updatedAt")
SELECT "key", MAX("sequence") + 1, CURRENT_TIMESTAMP
FROM (
    SELECT
        'PAY:' || substring("displayNumber" FROM '^PAY-([0-9]{6})-[0-9]+$') AS "key",
        substring("displayNumber" FROM '^PAY-[0-9]{6}-([0-9]+)$')::INTEGER AS "sequence"
    FROM "Payment"
    WHERE "displayNumber" ~ '^PAY-[0-9]{6}-[0-9]+$'

    UNION ALL

    SELECT
        'EXP:' || substring("displayNumber" FROM '^EXP-([0-9]{6})-[0-9]+$') AS "key",
        substring("displayNumber" FROM '^EXP-[0-9]{6}-([0-9]+)$')::INTEGER AS "sequence"
    FROM "Expense"
    WHERE "displayNumber" ~ '^EXP-[0-9]{6}-[0-9]+$'

    UNION ALL

    SELECT
        'BILL:' || substring("billNumber" FROM '^BILL-([0-9]{6})-[0-9]+$') AS "key",
        substring("billNumber" FROM '^BILL-[0-9]{6}-([0-9]+)$')::INTEGER AS "sequence"
    FROM "Bill"
    WHERE "billNumber" ~ '^BILL-[0-9]{6}-[0-9]+$'
) AS "issued"
GROUP BY "key";
