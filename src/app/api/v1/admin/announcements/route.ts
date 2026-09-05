/**
 * Admin announcements — list all + publish (spec §63, §145).
 * Escaped plain text only (client renders as text, never HTML). Audited.
 * Publishes are immediate (publishAt can be future for scheduling).
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { sweepOutboxSafe } from "@/lib/domain/notify";

const createSchema = z.object({
  title: z.string().trim().min(3, "Give the announcement a title.").max(140),
  message: z.string().trim().min(3, "Write the announcement message.").max(2000),
  type: z.enum(["INFO", "ALERT", "WARNING", "MAINTENANCE", "EVENT"]).default("INFO"),
  priority: z.enum(["NORMAL", "HIGH", "URGENT", "CRITICAL"]).default("NORMAL"),
  target: z.enum(["EVERYONE", "RESIDENTS", "ADMINS"]).default("EVERYONE"),
  publishAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  pinned: z.boolean().default(false),
  previewOnly: z.boolean().default(false),
});

import { getInstitution } from "@/lib/institution";
import { periodBounds } from "@/lib/domain/formula/period-variables";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const month = ctx.req.nextUrl.searchParams.get("month") ?? undefined;
  const where: Record<string, unknown> = { institutionId: ctx.institutionId };

  if (month) {
    const [yStr, mStr] = month.split("-");
    const inst = await getInstitution(ctx.institutionId);
    const tz = inst?.timezone ?? "Asia/Kolkata";
    const bounds = periodBounds(Number(yStr), Number(mStr), tz);
    where.AND = [
      { publishAt: { lt: bounds.endInstant } },
      {
        OR: [
          { expiresAt: null },
          { expiresAt: { gte: bounds.startInstant } },
        ],
      },
    ];
  }

  const rows = await db.announcement.findMany({
    where,
    orderBy: [{ pinned: "desc" }, { publishAt: "desc" }],
    take: 100,
  });
  return { data: rows, meta: { total: rows.length } };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const rl = await rateLimit(clientKey(ctx.req, "announcement-create"), 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(CODES.RATE_LIMITED, "Too many announcements. Try again later.", 429);
  }
  const body = await parseBody(ctx.req, createSchema);

  // Preview mode for critical/urgent publishes (spec §145) — no write happens.
  if (body.previewOnly) {
    return { data: { preview: true, announcement: body } };
  }

  const publishAt = body.publishAt ? new Date(body.publishAt) : new Date();
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt <= publishAt) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Expiry must come after publishing.", 400, {
      expiresAt: "Expiry must be after the publish date.",
    });
  }

  const created = await db.announcement.create({
    data: {
      institutionId: ctx.institutionId,
      title: body.title,
      message: body.message,
      type: body.type,
      priority: body.priority,
      target: body.target,
      publishAt,
      expiresAt,
      pinned: body.pinned,
      createdByUserId: ctx.user.id,
    },
  });

  await appendAudit({
    institutionId: ctx.institutionId,
    actorUserId: ctx.user.id,
    actorRole: "ADMIN",
    action: "ANNOUNCEMENT_PUBLISHED",
    entityType: "ANNOUNCEMENT",
    entityId: created.id,
    requestId: ctx.requestId,
    afterSummary: JSON.stringify({ title: body.title, type: body.type, priority: body.priority, target: body.target, pinned: body.pinned }),
  });

  await sweepOutboxSafe();
  return { data: created };
});
