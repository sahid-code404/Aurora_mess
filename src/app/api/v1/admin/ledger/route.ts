/**
 * GET /api/v1/admin/ledger — the double-entry ledger feed (auth ADMIN).
 * Journals (newest first, 50/page, keyset cursor) with their entries expanded
 * to account codes and formatted amounts. Meta: current account balances and
 * the reconciliation result (payments/expenses without journals, unbalanced
 * journals — all must be zero, mirroring the readiness gate).
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatMinor } from "@/lib/money";
import { finishPage, keysetWhere } from "@/lib/domain/http";
import { serializeJournal } from "@/lib/domain/serialize";
import { getAccountBalances, reconcileInstitution } from "@/lib/domain/ledger";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

  const { where, take } = keysetWhere({ institutionId: ctx.institutionId }, "createdAt", cursor, limit);
  const rows = await db.ledgerJournal.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    include: { entries: { include: { account: { select: { code: true, name: true } } }, orderBy: { id: "asc" } } },
  });
  const page = finishPage(rows, limit, (row) => row.createdAt);

  const [accounts, reconcile] = await Promise.all([
    getAccountBalances(ctx.institutionId),
    reconcileInstitution(ctx.institutionId),
  ]);

  return {
    data: page.items.map((j) => serializeJournal(j)),
    meta: {
      nextCursor: page.nextCursor,
      accounts: accounts.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
        debitMinor: a.debitMinor,
        creditMinor: a.creditMinor,
        balanceMinor: a.balanceMinor,
        balanceFormatted: formatMinor(a.balanceMinor),
      })),
      reconcile: {
        ...reconcile,
        balanced: reconcile.paymentsWithoutJournal === 0 && reconcile.expensesWithoutJournal === 0 && reconcile.unbalancedJournals === 0,
      },
    },
  };
});
