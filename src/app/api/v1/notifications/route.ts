/**
 * GET /api/v1/notifications — the signed-in user's notification list.
 * ?unread=1&cursor=&limit= (default 25, max 100). Newest first; cursor is
 * "<createdAtISO>~<id>". meta includes unreadCount and nextCursor.
 * An opportunistic outbox sweep runs FIRST (pending events → notification
 * rows); sweeper failures never bubble to the client.
 */
import { z } from "zod";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { sweepOutbox } from "@/lib/outbox";

const listQuerySchema = z.object({
  unread: z.string().optional(),
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

export const GET = route({ auth: "ANY" }, async (ctx) => {
  try {
    await sweepOutbox();
  } catch {
    /* sweeper failures must never break the list */
  }

  const query = parseQuery(listQuerySchema, ctx.req);
  const unreadOnly = query.unread === "1" || query.unread === "true";
  const cursorInfo = query.cursor ? decodeCursor(query.cursor) : null;

  const ACTIVITY_TYPES = ["GUEST_MEAL_ADDED", "GUEST_MEAL_ADJUSTED", "GUEST_MEAL_CANCELLED", "MEAL_TOGGLED"];
  const isResident = ctx.user.role === "RESIDENT";
  const typeFilter = isResident ? { notIn: ACTIVITY_TYPES } : undefined;

  const rows = await db.notification.findMany({
    where: {
      userId: ctx.user.id,
      institutionId: ctx.institutionId,
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(unreadOnly ? { readAt: null } : {}),
      ...(cursorInfo
        ? {
            OR: [
              { createdAt: { lt: cursorInfo.at } },
              { createdAt: { equals: cursorInfo.at }, id: { lt: cursorInfo.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}~${last.id}` : null;

  const unreadCount = await db.notification.count({
    where: {
      userId: ctx.user.id,
      institutionId: ctx.institutionId,
      ...(typeFilter ? { type: typeFilter } : {}),
      readAt: null,
    },
  });

  return {
    data: page.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      entityRef: n.entityRef,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    meta: { unreadCount, nextCursor },
  };
});
