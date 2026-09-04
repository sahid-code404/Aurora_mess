/**
 * LEDGER — immutable double-entry kernel (spec §19-21).
 * Every financial mutation posts a BALANCED journal in the SAME transaction
 * as the domain change. Posted journals are never edited; corrections post
 * new (reversal) journals.
 *
 * Chart of accounts (per institution):
 *   CASH              (asset)      — money the mess holds
 *   RESIDENT_FUNDS    (liability)  — money held on behalf of residents
 *   MESS_EXPENSE      (expense)    — grocery/market/operating spend
 *   MEAL_CHARGE_INCOME(income)     — resident meal charge recovery (bills)
 *   GUEST_INCOME      (income)     — guest meal charges
 *   REFUND_PAYABLE    (liability)  — refunds issued/owed out
 */
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";

export const ACCOUNT_CODES = {
  CASH: "CASH",
  RESIDENT_FUNDS: "RESIDENT_FUNDS",
  MESS_EXPENSE: "MESS_EXPENSE",
  MEAL_CHARGE_INCOME: "MEAL_CHARGE_INCOME",
  GUEST_INCOME: "GUEST_INCOME",
  REFUND_PAYABLE: "REFUND_PAYABLE",
} as const;

export type AccountCode = keyof typeof ACCOUNT_CODES;

const CHART: { code: AccountCode; name: string; type: string }[] = [
  { code: "CASH", name: "Cash & Bank", type: "ASSET" },
  { code: "RESIDENT_FUNDS", name: "Resident Funds Held", type: "LIABILITY" },
  { code: "MESS_EXPENSE", name: "Mess Expenses", type: "EXPENSE" },
  { code: "MEAL_CHARGE_INCOME", name: "Meal Charge Recovery", type: "INCOME" },
  { code: "GUEST_INCOME", name: "Guest Meal Income", type: "INCOME" },
  { code: "REFUND_PAYABLE", name: "Refunds Payable", type: "LIABILITY" },
];

/** Idempotently ensure the chart of accounts exists. Returns code→accountId. */
export async function ensureAccounts(institutionId: string, client: any = db): Promise<Record<string, string>> {
  const existing = await client.ledgerAccount.findMany({ where: { institutionId } });
  const map: Record<string, string> = {};
  for (const acc of existing) map[acc.code] = acc.id;
  const missing = CHART.filter((c) => !map[c.code]);
  if (missing.length > 0) {
    await client.ledgerAccount.createMany({
      data: missing.map((c) => ({ institutionId, code: c.code, name: c.name, type: c.type })),
    });
    const refreshed = await client.ledgerAccount.findMany({ where: { institutionId } });
    for (const acc of refreshed) map[acc.code] = acc.id;
  }
  return map;
}

export type JournalLine = { accountCode: AccountCode; debitMinor?: number; creditMinor?: number };

export type PostJournalInput = {
  institutionId: string;
  description: string;
  refType?: string;
  refId?: string;
  createdByUserId?: string | null;
  lines: JournalLine[];
};

/**
 * Post a balanced journal. MUST be called within the caller's transaction when
 * the mutation must be atomic with domain state (payment approval, etc.) —
 * pass the tx client. Validates balance BEFORE writing.
 */
export async function postJournal(input: PostJournalInput, client: any = db): Promise<{ journalId: string }> {
  const lines = input.lines.filter((l) => (l.debitMinor ?? 0) > 0 || (l.creditMinor ?? 0) > 0);
  if (lines.length < 2) {
    throw new ApiError(CODES.INTERNAL, "Journal needs at least two non-zero lines.", 500);
  }
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    if ((l.debitMinor ?? 0) < 0 || (l.creditMinor ?? 0) < 0) {
      throw new ApiError(CODES.INTERNAL, "Journal amounts must be positive.", 500);
    }
    if ((l.debitMinor ?? 0) > 0 && (l.creditMinor ?? 0) > 0) {
      throw new ApiError(CODES.INTERNAL, "A journal line cannot be both debit and credit.", 500);
    }
    debit += l.debitMinor ?? 0;
    credit += l.creditMinor ?? 0;
  }
  if (debit !== credit) {
    throw new ApiError(CODES.INTERNAL, `Journal is unbalanced (Dr ${debit} ≠ Cr ${credit}).`, 500);
  }
  const accounts = await ensureAccounts(input.institutionId, client);
  const journal = await client.ledgerJournal.create({
    data: {
      institutionId: input.institutionId,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      description: input.description,
      createdByUserId: input.createdByUserId ?? null,
    },
  });
  await client.ledgerEntry.createMany({
    data: lines.map((l) => ({
      journalId: journal.id,
      accountId: accounts[l.accountCode],
      debitMinor: l.debitMinor ?? 0,
      creditMinor: l.creditMinor ?? 0,
    })),
  });
  return { journalId: journal.id };
}

export type AccountBalance = {
  code: string;
  name: string;
  type: string;
  debitMinor: number;
  creditMinor: number;
  /** Signed balance by account type (asset/expense: Dr−Cr; liability/income: Cr−Dr). */
  balanceMinor: number;
};

/** Read model: per-account balances for the admin funds/ledger views. */
export async function getAccountBalances(institutionId: string, client: any = db): Promise<AccountBalance[]> {
  const accounts = await client.ledgerAccount.findMany({
    where: { institutionId },
    include: { entries: { select: { debitMinor: true, creditMinor: true } } },
  });
  return accounts.map((a: any) => {
    const debit = a.entries.reduce((s: number, e: any) => s + e.debitMinor, 0);
    const credit = a.entries.reduce((s: number, e: any) => s + e.creditMinor, 0);
    const isDebitNature = a.type === "ASSET" || a.type === "EXPENSE";
    return {
      code: a.code,
      name: a.name,
      type: a.type,
      debitMinor: debit,
      creditMinor: credit,
      balanceMinor: isDebitNature ? debit - credit : credit - debit,
    };
  });
}

/**
 * Reconciliation core (spec §219): approved payments/expenses/refunds must have
 * exactly one posted journal each. Returns mismatch lists (empty = reconciled).
 */
export async function reconcileInstitution(institutionId: string): Promise<{
  paymentsWithoutJournal: number;
  expensesWithoutJournal: number;
  unbalancedJournals: number;
}> {
  const [payments, expenses, journals] = await Promise.all([
    db.payment.count({ where: { institutionId, status: "APPROVED", approvedJournalId: null } }),
    db.expense.count({ where: { institutionId, status: "APPROVED", journalId: null } }),
    db.ledgerJournal.findMany({
      where: { institutionId, status: "POSTED" },
      include: { entries: { select: { debitMinor: true, creditMinor: true } } },
    }),
  ]);
  const unbalanced = journals.filter(
    (j) => j.entries.reduce((s, e) => s + e.debitMinor, 0) !== j.entries.reduce((s, e) => s + e.creditMinor, 0)
  ).length;
  return { paymentsWithoutJournal: payments, expensesWithoutJournal: expenses, unbalancedJournals: unbalanced };
}
