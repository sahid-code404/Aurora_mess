/**
 * Human-facing sequential-ish display numbers (spec §254): PAY-202609-0042.
 * Internal authorization always uses opaque cuid ids.
 */
import { db } from "@/lib/db";

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function monthStamp(date = new Date()): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}`;
}

async function nextSequence(
  table: "Payment" | "Expense" | "Bill",
  stamp: string
): Promise<number> {
  // Count-with-retry under the caller's transaction; unique constraint is the final guard.
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await (table === "Payment"
      ? db.payment.count({ where: { displayNumber: { startsWith: `PAY-${stamp}` } } })
      : table === "Expense"
        ? db.expense.count({ where: { displayNumber: { startsWith: `EXP-${stamp}` } } })
        : db.bill.count({ where: { billNumber: { startsWith: `BILL-${stamp}` } } }));
    const seq = count + 1 + attempt;
    // verify candidate is actually free
    const existing =
      table === "Payment"
        ? await db.payment.findUnique({ where: { displayNumber: `PAY-${stamp}-${pad(seq, 4)}` } })
        : table === "Expense"
          ? await db.expense.findUnique({ where: { displayNumber: `EXP-${stamp}-${pad(seq, 4)}` } })
          : await db.bill.findUnique({ where: { billNumber: `BILL-${stamp}-${pad(seq, 4)}` } });
    if (!existing) return seq;
  }
  throw new Error("DISPLAY_NUMBER_EXHAUSTED");
}

export async function nextPaymentNumber(): Promise<string> {
  return `PAY-${monthStamp()}-${pad(await nextSequence("Payment", monthStamp()), 4)}`;
}

export async function nextExpenseNumber(): Promise<string> {
  return `EXP-${monthStamp()}-${pad(await nextSequence("Expense", monthStamp()), 4)}`;
}

export async function nextBillNumber(year: number, month: number): Promise<string> {
  const stamp = `${year}${pad(month, 2)}`;
  return `BILL-${stamp}-${pad(await nextSequence("Bill", stamp), 4)}`;
}
