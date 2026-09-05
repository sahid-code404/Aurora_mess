/**
 * Human-facing sequential-ish display numbers (spec §254): PAY-202609-0042.
 * Internal authorization always uses opaque cuid ids.
 *
 * Allocation is persisted in DisplayNumberSequence with one atomic PostgreSQL
 * UPSERT per prefix/month. This prevents two concurrent requests from receiving
 * the same candidate. Callers inside an existing write transaction should still
 * pass that transaction client so allocation commits or rolls back with the
 * business write; callers outside a transaction may use the global default and
 * accept harmless gaps if their later write fails.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type SequenceClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type SequencePrefix = "PAY" | "EXP" | "BILL";
type SequenceRow = { allocated: number };

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function monthStamp(date = new Date()): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}`;
}

async function nextSequence(
  prefix: SequencePrefix,
  stamp: string,
  client: SequenceClient
): Promise<number> {
  const key = `${prefix}:${stamp}`;
  const rows = await client.$queryRaw<SequenceRow[]>(Prisma.sql`
    INSERT INTO "DisplayNumberSequence" ("key", "nextValue", "updatedAt")
    VALUES (${key}, 2, CURRENT_TIMESTAMP)
    ON CONFLICT ("key") DO UPDATE
    SET
      "nextValue" = "DisplayNumberSequence"."nextValue" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextValue" - 1 AS "allocated"
  `);

  const allocated = rows[0]?.allocated;
  if (!Number.isSafeInteger(allocated) || allocated <= 0) {
    throw new Error("DISPLAY_NUMBER_SEQUENCE_INVALID");
  }
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
