/**
 * GET /api/v1/admin/audit — append-only audit trail, newest first.
 * ?entityType= &entityId= &action= &cursor= &limit=50 (max 100).
 * Cursor: "<occurredAtISO>~<id>". metadataJson is parsed into `metadata`.
 */
import { z } from "zod";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { getInstitution } from "@/lib/institution";
import { periodBounds } from "@/lib/domain/formula/period-variables";

const auditQuerySchema = z.object({
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(64).optional(),
  action: z.string().trim().max(60).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Months use the YYYY-MM format.").optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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

function parseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const query = parseQuery(auditQuerySchema, ctx.req);
  const cursorInfo = query.cursor ? decodeCursor(query.cursor) : null;

  const conditions: Prisma.AuditEventWhereInput[] = [{ institutionId: ctx.institutionId }];
  if (query.entityType) conditions.push({ entityType: query.entityType });
  if (query.entityId) conditions.push({ entityId: query.entityId });
  if (query.action) conditions.push({ action: query.action });

  if (query.month) {
    const inst = await getInstitution(ctx.institutionId);
    const tz = inst?.timezone ?? "Asia/Kolkata";
    const [yStr, mStr] = query.month.split("-");
    const bounds = periodBounds(Number(yStr), Number(mStr), tz);
    conditions.push({
      occurredAt: {
        gte: bounds.startInstant,
        lt: bounds.endInstant,
      },
    });
  }

  if (cursorInfo) {
    conditions.push({
      OR: [
        { occurredAt: { lt: cursorInfo.at } },
        { occurredAt: { equals: cursorInfo.at }, id: { lt: cursorInfo.id } },
      ],
    });
  }

  const rows = await db.auditEvent.findMany({
    where: { AND: conditions },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.occurredAt.toISOString()}~${last.id}` : null;

  return {
    data: page.map((a) => ({
      id: a.id,
      action: a.action,
      actorUserId: a.actorUserId,
      actorRole: a.actorRole,
      entityType: a.entityType,
      entityId: a.entityId,
      reason: a.reason,
      beforeSummary: a.beforeSummary,
      afterSummary: a.afterSummary,
      metadata: parseMetadata(a.metadataJson),
      requestId: a.requestId,
      occurredAt: a.occurredAt,
      ip: a.ip,
      userAgent: a.userAgent,
    })),
    meta: { nextCursor },
  };
});
