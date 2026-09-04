/**
 * LIST helper — newest-first seek pagination via ?limit&cursor (cursor=id).
 * Order is (createdAt desc, id desc); the cursor anchors a (createdAt, id)
 * tuple seek so pages are stable even when createdAt values tie.
 * Meals endpoints are bounded by date range and never paginate.
 */
import { paginationSchema } from "@/lib/validation";
import { ApiError, CODES } from "@/lib/errors";

export function listQuery(searchParams: URLSearchParams): { limit: number; cursor?: string } {
  const obj: Record<string, string> = {};
  for (const [k, v] of searchParams.entries()) obj[k] = v;
  const parsed = paginationSchema.safeParse(obj);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "form";
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the list filters.", 400, fields);
  }
  return parsed.data;
}

export async function seekList(params: {
  client: any;
  model: string;
  where: Record<string, unknown>;
  limit: number;
  cursor?: string;
  include?: unknown;
  orderBy?: Record<string, "asc" | "desc">[];
}): Promise<{ items: any[]; nextCursor: string | null }> {
  const { client, model, where, limit, cursor, include } = params;
  let finalWhere: Record<string, unknown> = where;
  if (cursor) {
    const anchor = await client[model].findUnique({
      where: { id: cursor },
      select: { id: true, createdAt: true },
    });
    if (anchor) {
      finalWhere = {
        ...where,
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: { equals: anchor.createdAt }, id: { lt: anchor.id } },
        ],
      };
    }
  }
  const items = await client[model].findMany({
    where: finalWhere,
    orderBy: params.orderBy ?? [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(include ? { include } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
  return { items: page, nextCursor };
}
