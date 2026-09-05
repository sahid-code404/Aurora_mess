/**
 * Human-facing sequential-ish display numbers (spec §254): PAY-202609-0042.
 * Internal authorization always uses opaque cuid ids.
 *
 * Allocation reconciles the highest identifier visible to the caller with a
 * DisplayNumberSequence row, then advances that row with one atomic PostgreSQL
 * UPSERT. This preserves transaction-local visibility while preventing two
 * concurrent requests from receiving the same candidate.
 *
 * Callers inside an existing write transaction should pass that transaction
 * client so allocation commits or rolls back with the business write. Callers
 * outside a transaction may use the global default and accept harmless gaps if
 * their later write fails.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type SequenceClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type SequencePrefix = "PAY" | "EXP" | "BILL";
type SequenceRangeRow = { startAllocated: number };
type MaxSequenceRow = { maxSequence: number | null };

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function monthStamp(date = new Date()): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}`;
}

async function highestVisibleSequence(
  prefix: SequencePrefix,
  stamp: string,
  client: SequenceClient
): Promise<number> {
  const pattern = `^${prefix}-${stamp}-[0-9]+$`;
  const rows =
    prefix === "PAY"
      ? await client.$queryRaw<MaxSequenceRow[]>(Prisma.sql`
          SELECT MAX(split_part("displayNumber", '-', 3)::INTEGER) AS "maxSequence"
          FROM "Payment"
          WHERE "displayNumber" ~ ${pattern}
        `)
      : prefix === "EXP"
        ? await client.$queryRaw<MaxSequenceRow[]>(Prisma.sql`
            SELECT MAX(split_part("displayNumber", '-', 3)::INTEGER) AS "maxSequence"
            FROM "Expense"
            WHERE "displayNumber" ~ ${pattern}
          `)
        : await client.$queryRaw<MaxSequenceRow[]>(Prisma.sql`
            SELECT MAX(split_part("billNumber", '-', 3)::INTEGER) AS "maxSequence"
            FROM "Bill"
            WHERE "billNumber" ~ ${pattern}
          `);

  const maxSequence = rows[0]?.maxSequence ?? 0;
  if (!Number.isSafeInteger(maxSequence) || maxSequence < 0) {
    throw new Error("DISPLAY_NUMBER_SEQUENCE_INVALID");
  }
  return maxSequence;
}

/**
 * Atomically reserve one contiguous range from a prefix/month sequence.
 *
 * The existing row's `nextValue` is the first unallocated value. On conflict we
 * advance it by the entire requested range in one row-locked UPSERT, while
 * GREATEST also catches a stale sequence row up to identifiers already visible
 * inside the caller's transaction. This is what lets two different billing
 * transactions reserve non-overlapping BILL ranges for the same month.
 */
async function reserveSequences(
  prefix: SequencePrefix,
  stamp: string,
  count: number,
  client: SequenceClient
): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("DISPLAY_NUMBER_RESERVATION_INVALID");
  }
  if (count === 0) return [];

  const key = `${prefix}:${stamp}`;
  const highestVisible = await highestVisibleSequence(prefix, stamp, client);
  const firstUnallocatedAfterVisible = highestVisible + 1;
  const storedNextValueAfterReservation = firstUnallocatedAfterVisible + count;
  if (!Number.isSafeInteger(storedNextValueAfterReservation)) {
    throw new Error("DISPLAY_NUMBER_SEQUENCE_INVALID");
  }

  const rows = await client.$queryRaw<SequenceRangeRow[]>(Prisma.sql`
    INSERT INTO "DisplayNumberSequence" ("key", "nextValue", "updatedAt")
    VALUES (${key}, ${storedNextValueAfterReservation}, CURRENT_TIMESTAMP)
    ON CONFLICT ("key") DO UPDATE
    SET
      "nextValue" = GREATEST(
        "DisplayNumberSequence"."nextValue" + ${count},
        EXCLUDED."nextValue"
      ),
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING ("nextValue" - ${count})::INTEGER AS "startAllocated"
  `);

  const startAllocated = rows[0]?.startAllocated;
  const lastAllocated = (startAllocated ?? 0) + count - 1;
  if (
    !Number.isSafeInteger(startAllocated) ||
    (startAllocated ?? 0) <= 0 ||
    !Number.isSafeInteger(lastAllocated)
  ) {
    throw new Error("DISPLAY_NUMBER_SEQUENCE_INVALID");
  }

  return Array.from({ length: count }, (_, index) => (startAllocated as number) + index);
}

async function nextSequence(
  prefix: SequencePrefix,
  stamp: string,
  client: SequenceClient
): Promise<number> {
  const [allocated] = await reserveSequences(prefix, stamp, 1, client);
  if (!allocated) throw new Error("DISPLAY_NUMBER_SEQUENCE_INVALID");
  return allocated;
}

export async function nextPaymentNumber(
  client: SequenceClient = db,
  date = new Date()
): Promise<string> {
  const stamp = monthStamp(date);
  return `PAY-${stamp}-${pad(await nextSequence("PAY", stamp, client), 4)}`;
}

export async function nextExpenseNumber(
  client: SequenceClient = db,
  date = new Date()
): Promise<string> {
  const stamp = monthStamp(date);
  return `EXP-${stamp}-${pad(await nextSequence("EXP", stamp, client), 4)}`;
}

export async function nextBillNumber(
  year: number,
  month: number,
  client: SequenceClient = db
): Promise<string> {
  const stamp = `${year}${pad(month, 2)}`;
  return `BILL-${stamp}-${pad(await nextSequence("BILL", stamp, client), 4)}`;
}

/** Reserve a contiguous set of bill numbers in one atomic sequence operation. */
export async function nextBillNumbers(
  year: number,
  month: number,
  count: number,
  client: SequenceClient = db
): Promise<string[]> {
  const stamp = `${year}${pad(month, 2)}`;
  const allocated = await reserveSequences("BILL", stamp, count, client);
  return allocated.map((sequence) => `BILL-${stamp}-${pad(sequence, 4)}`);
}
