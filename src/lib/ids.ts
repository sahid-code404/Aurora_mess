/**
 * Human-facing sequential-ish display numbers (spec §254): PAY-202609-0042.
 * Internal authorization always uses opaque cuid ids.
 *
 * Callers that allocate a number inside an existing write transaction MUST pass
 * that transaction client. Otherwise the allocator cannot see the caller's
 * uncommitted rows and may choose a number that the same transaction already
 * consumed. Outside a transaction the default global Prisma client is fine.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type SequenceClient = Pick<Prisma.TransactionClient, "payment" | "expense" | "bill">;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function monthStamp(date = new Date()): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}`;
}

async function nextSequence(
  table: "Payment" | "Expense" | "Bill",
  stamp: string,
  client: SequenceClient
): Promise<number> {
  // Count-with-retry is intentionally evaluated through the supplied client so
  // a transaction sees its own uncommitted inserts. Database UNIQUE constraints
  // remain the final cross-transaction collision guard.
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await (table === "Payment"
      ? client.payment.count({ where: { displayNumber: { startsWith: `PAY-${stamp}` } } })
      : table === "Expense"
        ? client.expense.count({ where: { displayNumber: { startsWith: `EXP-${stamp}` } } })
        : client.bill.count({ where: { billNumber: { startsWith: `BILL-${stamp}` } } }));
    const seq = count + 1 + attempt;

    const existing =
      table === "Payment"
        ? await client.payment.findUnique({ where: { displayNumber: `PAY-${stamp}-${pad(seq, 4)}` } })
        : table === "Expense"
          ? await client.expense.findUnique({ where: { displayNumber: `EXP-${stamp}-${pad(seq, 4)}` } })
          : await client.bill.findUnique({ where: { billNumber: `BILL-${stamp}-${pad(seq, 4)}` } });
    if (!existing) return seq;
  }
  throw new Error("DISPLAY_NUMBER_EXHAUSTED");
}

export async function nextPaymentNumber(
  client: SequenceClient = db,
  date = new Date()
): Promise<string> {
  const stamp = monthStamp(date);
  return `PAY-${stamp}-${pad(await nextSequence("Payment", stamp, client), 4)}`;
}

export async function nextExpenseNumber(
  client: SequenceClient = db,
  date = new Date()
): Promise<string> {
  const stamp = monthStamp(date);
  return `EXP-${stamp}-${pad(await nextSequence("Expense", stamp, client), 4)}`;
}

export async function nextBillNumber(
  year: number,
  month: number,
  client: SequenceClient = db
): Promise<string> {
  const stamp = `${year}${pad(month, 2)}`;
  return `BILL-${stamp}-${pad(await nextSequence("Bill", stamp, client), 4)}`;
}
