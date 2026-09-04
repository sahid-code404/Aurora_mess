/**
 * GET /api/v1/admin/residents — resident roster (spec §131-134).
 * ?q= (name/email contains) &status= &cursor= &limit=25 (max 100).
 * Rows include profile, status, membership dates and the derived funds
 * summary (computed in parallel for the page; only for billable statuses).
 * KPI meta: { total, active, pending } — "total" counts RESIDENT users with
 * status ACTIVE | INACTIVE | CHANGES_REQUESTED (excludes PENDING/REJECTED).
 */
import { z } from "zod";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { residentFundsSummary } from "@/lib/domain/funds";

const listQuerySchema = z.object({
  q: z.string().trim().max(60, "Search text is too long.").optional(),
  status: z
    .enum([
      "PENDING_APPROVAL",
      "CHANGES_REQUESTED",
      "REJECTED",
      "ACTIVE",
      "INACTIVE",
      "PENDING_DELETION",
    ])
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function parseQuery<T>(
  schema: {
    safeParse: (
      v: unknown
    ) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number | symbol)[]; message: string }[] } };
  },
  req: NextRequest
): T {
  const raw: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    if (value !== "") raw[key] = value;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "query";
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the request parameters.", 400, fields);
  }
  return parsed.data;
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const sep = cursor.indexOf("~");
  if (sep <= 0) return null;
  const at = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || !id) return null;
  return { at, id };
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const query = parseQuery(listQuerySchema, ctx.req);
  const cursorInfo = query.cursor ? decodeCursor(query.cursor) : null;

  const conditions: Prisma.UserWhereInput[] = [
    { institutionId: ctx.institutionId },
    { role: "RESIDENT" },
  ];
  if (query.status) conditions.push({ status: query.status });
  if (query.q) {
    conditions.push({
      OR: [
        { email: { contains: query.q } },
        { profile: { fullName: { contains: query.q } } },
      ],
    });
  }
  if (cursorInfo) {
    conditions.push({
      OR: [
        { createdAt: { lt: cursorInfo.at } },
        { createdAt: { equals: cursorInfo.at }, id: { lt: cursorInfo.id } },
      ],
    });
  }

  const rows = await db.user.findMany({
    where: { AND: conditions },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: {
      profile: { select: { fullName: true, phone: true, roomNumber: true } },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}~${last.id}` : null;

  // Funds summaries in parallel, only for billable states (spec §42).
  const billable = page.filter((u) => u.status === "ACTIVE" || u.status === "INACTIVE");
  const summaries = await Promise.all(billable.map((u) => residentFundsSummary(u.id)));
  const fundsByUser = new Map(summaries.map((s) => [s.residentId, s]));

  const [total, active, pending] = await Promise.all([
    db.user.count({
      where: {
        institutionId: ctx.institutionId,
        role: "RESIDENT",
        status: { in: ["ACTIVE", "INACTIVE", "CHANGES_REQUESTED"] },
      },
    }),
    db.user.count({
      where: { institutionId: ctx.institutionId, role: "RESIDENT", status: "ACTIVE" },
    }),
    db.user.count({
      where: { institutionId: ctx.institutionId, role: "RESIDENT", status: "PENDING_APPROVAL" },
    }),
  ]);

  const data = page.map((u) => ({
    id: u.id,
    email: u.email,
    status: u.status,
    createdAt: u.createdAt,
    membershipEffectiveFrom: u.membershipEffectiveFrom,
    membershipEffectiveUntil: u.membershipEffectiveUntil,
    profile: u.profile
      ? {
          fullName: u.profile.fullName,
          phone: u.profile.phone,
          roomNumber: u.profile.roomNumber,
        }
      : null,
    funds: fundsByUser.get(u.id) ?? null,
  }));

  const sortedData = [...data].sort((a, b) => {
    const getRank = (st: string) => {
      if (st === "PENDING_APPROVAL") return 0; // Needs admin approval
      if (st === "CHANGES_REQUESTED" || st === "PENDING_DELETION") return 1; // Needs review/attention
      if (st === "ACTIVE") return 2;
      return 3;
    };
    const rA = getRank(a.status);
    const rB = getRank(b.status);
    if (rA !== rB) return rA - rB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return { data: sortedData, meta: { total, active, pending, nextCursor } };
});
