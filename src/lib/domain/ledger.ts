/**
 * LEDGER — immutable double-entry kernel (spec §19-21).
 * Every financial mutation posts a BALANCED journal in the SAME transaction
 * as the domain change. Posted journals are never edited or deleted;
 * corrections post new reversal/correction journals.
 */
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { PAYMENT_LEDGER_STATUSES } from "@/lib/domain/payment-lifecycle";

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

export type ReconciliationResult = {
  paymentsWithoutJournal: number;
  paymentJournalLinkMismatches: number;
  voidedPaymentsWithoutReversalJournal: number;
  paymentReversalLinkMismatches: number;
  expensesWithoutJournal: number;
  expenseJournalLinkMismatches: number;
  voidedExpensesWithoutReversalJournal: number;
  expenseReversalLinkMismatches: number;
  cashRefundsWithoutJournal: number;
  refundJournalLinkMismatches: number;
  refundLegacyReferenceWarnings: number;
  carryForwardsWithJournal: number;
  billsWithoutJournal: number;
  billsWithDuplicateJournals: number;
  unbalancedJournals: number;
  journalsWithoutEntries: number;
  orphanPaymentExpenseBillJournals: number;
  problems: string[];
  warnings: string[];
  balanced: boolean;
};

type JournalRow = {
  id: string;
  institutionId: string;
  refType: string | null;
  refId: string | null;
  status: string;
  entries: { debitMinor: number; creditMinor: number }[];
};

function linkedJournalMatches(
  journal: JournalRow | undefined,
  institutionId: string,
  refType: string,
  refId: string
): boolean {
  return Boolean(
    journal &&
      journal.institutionId === institutionId &&
      journal.status === "POSTED" &&
      journal.refType === refType &&
      journal.refId === refId
  );
}

/**
 * Reconcile domain records against immutable journals. `client` may be a Prisma
 * transaction client, allowing billing readiness to use this exact same kernel
 * instead of maintaining a second, slightly different reconciliation query.
 *
 * Historical refund journals created before Phase 10 may point at paymentId
 * instead of refundId. Those remain a non-blocking provenance warning when the
 * exact journal row still exists, is POSTED, belongs to the institution, and is
 * typed REFUND. New refunds are always linked by refundId.
 */
export async function reconcileInstitution(
  institutionId: string,
  client: any = db
): Promise<ReconciliationResult> {
  const [payments, expenses, refunds, bills, journalsRaw] = await Promise.all([
    client.payment.findMany({
      where: {
        institutionId,
        status: { in: [...PAYMENT_LEDGER_STATUSES] },
      },
      select: { id: true, status: true, approvedJournalId: true, voidJournalId: true },
    }),
    client.expense.findMany({
      where: { institutionId, status: { in: ["APPROVED", "VOIDED"] } },
      select: { id: true, status: true, journalId: true, reversalJournalId: true },
    }),
    client.refund.findMany({
      where: { institutionId, status: "COMPLETED" },
      select: { id: true, mode: true, paymentId: true, journalId: true },
    }),
    client.bill.findMany({
      where: { institutionId, subtotalMinor: { gt: 0 } },
      select: { id: true },
    }),
    client.ledgerJournal.findMany({
      where: { institutionId, status: "POSTED" },
      include: { entries: { select: { debitMinor: true, creditMinor: true } } },
    }),
  ]);

  const journals = journalsRaw as JournalRow[];
  const journalById = new Map<string, JournalRow>(journals.map((journal) => [journal.id, journal] as const));

  let paymentsWithoutJournal = 0;
  let paymentJournalLinkMismatches = 0;
  let voidedPaymentsWithoutReversalJournal = 0;
  let paymentReversalLinkMismatches = 0;
  for (const payment of payments as any[]) {
    if (!payment.approvedJournalId) paymentsWithoutJournal += 1;
    else if (!linkedJournalMatches(journalById.get(payment.approvedJournalId), institutionId, "PAYMENT", payment.id)) {
      paymentJournalLinkMismatches += 1;
    }
    if (payment.status === "VOIDED") {
      if (!payment.voidJournalId) voidedPaymentsWithoutReversalJournal += 1;
      else if (!linkedJournalMatches(journalById.get(payment.voidJournalId), institutionId, "PAYMENT", payment.id)) {
        paymentReversalLinkMismatches += 1;
      }
    }
  }

  let expensesWithoutJournal = 0;
  let expenseJournalLinkMismatches = 0;
  let voidedExpensesWithoutReversalJournal = 0;
  let expenseReversalLinkMismatches = 0;
  for (const expense of expenses as any[]) {
    if (!expense.journalId) expensesWithoutJournal += 1;
    else if (!linkedJournalMatches(journalById.get(expense.journalId), institutionId, "EXPENSE", expense.id)) {
      expenseJournalLinkMismatches += 1;
    }
    if (expense.status === "VOIDED") {
      if (!expense.reversalJournalId) voidedExpensesWithoutReversalJournal += 1;
      else if (!linkedJournalMatches(journalById.get(expense.reversalJournalId), institutionId, "EXPENSE", expense.id)) {
        expenseReversalLinkMismatches += 1;
      }
    }
  }

  let cashRefundsWithoutJournal = 0;
  let refundJournalLinkMismatches = 0;
  let refundLegacyReferenceWarnings = 0;
  let carryForwardsWithJournal = 0;
  for (const refund of refunds as any[]) {
    if (refund.mode === "CARRY_FORWARD") {
      if (refund.journalId) carryForwardsWithJournal += 1;
      continue;
    }
    if (refund.mode !== "ISSUE_REFUND") continue;
    if (!refund.journalId) {
      cashRefundsWithoutJournal += 1;
      continue;
    }
    const journal = journalById.get(refund.journalId);
    if (!journal || journal.institutionId !== institutionId || journal.status !== "POSTED" || journal.refType !== "REFUND") {
      refundJournalLinkMismatches += 1;
      continue;
    }
    if (journal.refId !== refund.id) {
      // Pre-Phase-10 rows used paymentId (or null) as REFUND refId. Only those
      // exact legacy shapes are warnings; an unrelated reference is corruption.
      if (journal.refId == null || (refund.paymentId != null && journal.refId === refund.paymentId)) {
        refundLegacyReferenceWarnings += 1;
      } else {
        refundJournalLinkMismatches += 1;
      }
    }
  }

  const billIds = new Set((bills as any[]).map((bill) => bill.id));
  const billJournalCounts = new Map<string, number>();
  for (const journal of journals) {
    if (journal.refType === "BILL" && journal.refId && billIds.has(journal.refId)) {
      billJournalCounts.set(journal.refId, (billJournalCounts.get(journal.refId) ?? 0) + 1);
    }
  }
  let billsWithoutJournal = 0;
  let billsWithDuplicateJournals = 0;
  for (const billId of billIds) {
    const count = billJournalCounts.get(billId) ?? 0;
    if (count === 0) billsWithoutJournal += 1;
    if (count > 1) billsWithDuplicateJournals += 1;
  }

  let unbalancedJournals = 0;
  let journalsWithoutEntries = 0;
  for (const journal of journals) {
    if (journal.entries.length === 0) journalsWithoutEntries += 1;
    const debit = journal.entries.reduce((sum, entry) => sum + entry.debitMinor, 0);
    const credit = journal.entries.reduce((sum, entry) => sum + entry.creditMinor, 0);
    if (debit !== credit) unbalancedJournals += 1;
  }

  const paymentIds = new Set((payments as any[]).map((row) => row.id));
  const expenseIds = new Set((expenses as any[]).map((row) => row.id));
  let orphanPaymentExpenseBillJournals = 0;
  for (const journal of journals) {
    if (!journal.refId) continue;
    if (journal.refType === "PAYMENT" && !paymentIds.has(journal.refId)) orphanPaymentExpenseBillJournals += 1;
    if (journal.refType === "EXPENSE" && !expenseIds.has(journal.refId)) orphanPaymentExpenseBillJournals += 1;
    if (journal.refType === "BILL" && !billIds.has(journal.refId)) orphanPaymentExpenseBillJournals += 1;
  }

  const problems = [
    paymentsWithoutJournal > 0 ? `${paymentsWithoutJournal} payment(s) without an approval journal` : null,
    paymentJournalLinkMismatches > 0 ? `${paymentJournalLinkMismatches} payment approval journal link mismatch(es)` : null,
    voidedPaymentsWithoutReversalJournal > 0
      ? `${voidedPaymentsWithoutReversalJournal} voided payment(s) without a reversal journal`
      : null,
    paymentReversalLinkMismatches > 0 ? `${paymentReversalLinkMismatches} payment reversal journal link mismatch(es)` : null,
    expensesWithoutJournal > 0 ? `${expensesWithoutJournal} expense(s) without an approval journal` : null,
    expenseJournalLinkMismatches > 0 ? `${expenseJournalLinkMismatches} expense journal link mismatch(es)` : null,
    voidedExpensesWithoutReversalJournal > 0
      ? `${voidedExpensesWithoutReversalJournal} voided expense(s) without a reversal journal`
      : null,
    expenseReversalLinkMismatches > 0 ? `${expenseReversalLinkMismatches} expense reversal journal link mismatch(es)` : null,
    cashRefundsWithoutJournal > 0 ? `${cashRefundsWithoutJournal} issued refund(s) without a journal` : null,
    refundJournalLinkMismatches > 0 ? `${refundJournalLinkMismatches} refund journal link mismatch(es)` : null,
    carryForwardsWithJournal > 0 ? `${carryForwardsWithJournal} carry-forward refund(s) incorrectly posted to the ledger` : null,
    billsWithoutJournal > 0 ? `${billsWithoutJournal} non-zero bill(s) without a journal` : null,
    billsWithDuplicateJournals > 0 ? `${billsWithDuplicateJournals} bill(s) with duplicate journals` : null,
    unbalancedJournals > 0 ? `${unbalancedJournals} unbalanced posted journal(s)` : null,
    journalsWithoutEntries > 0 ? `${journalsWithoutEntries} posted journal(s) without entries` : null,
    orphanPaymentExpenseBillJournals > 0
      ? `${orphanPaymentExpenseBillJournals} payment/expense/bill journal(s) reference missing domain records`
      : null,
  ].filter((problem): problem is string => problem != null);

  const warnings = [
    refundLegacyReferenceWarnings > 0
      ? `${refundLegacyReferenceWarnings} historical refund journal(s) use the pre-Phase-10 payment/null reference format`
      : null,
  ].filter((warning): warning is string => warning != null);

  return {
    paymentsWithoutJournal,
    paymentJournalLinkMismatches,
    voidedPaymentsWithoutReversalJournal,
    paymentReversalLinkMismatches,
    expensesWithoutJournal,
    expenseJournalLinkMismatches,
    voidedExpensesWithoutReversalJournal,
    expenseReversalLinkMismatches,
    cashRefundsWithoutJournal,
    refundJournalLinkMismatches,
    refundLegacyReferenceWarnings,
    carryForwardsWithJournal,
    billsWithoutJournal,
    billsWithDuplicateJournals,
    unbalancedJournals,
    journalsWithoutEntries,
    orphanPaymentExpenseBillJournals,
    problems,
    warnings,
    balanced: problems.length === 0,
  };
}
