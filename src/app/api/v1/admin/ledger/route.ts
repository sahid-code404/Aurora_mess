/**
 * GET /api/v1/admin/ledger — the double-entry ledger feed (auth ADMIN).
 * Journals (newest first, keyset pagination) with account balances and one
 * authoritative reconciliation result shared with billing readiness.
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
    data: page.items.map((journal) => serializeJournal(journal)),
    meta: {
      nextCursor: page.nextCursor,
      accounts: accounts.map((account) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        debitMinor: account.debitMinor,
        creditMinor: account.creditMinor,
        balanceMinor: account.balanceMinor,
        balanceFormatted: formatMinor(account.balanceMinor),
      })),
      reconcile,
    },
  };
});
