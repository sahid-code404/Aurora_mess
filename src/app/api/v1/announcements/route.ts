/**
 * GET /api/v1/announcements — active announcements visible to the signed-in
 * role: target EVERYONE or the caller's role, publishAt <= now, not expired,
 * and not archived by the append-only announcement lifecycle.
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { decorateAnnouncementLifecycle } from "@/lib/domain/announcement-lifecycle";

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const now = new Date();
  const targets =
    ctx.user.role === "ADMIN" ? ["EVERYONE", "ADMINS"] : ["EVERYONE", "RESIDENTS"];

  // Fetch beyond the response limit because archived records are filtered by
  // the append-only lifecycle stream after the publication-window query.
  const rows = await db.announcement.findMany({
    where: {
      institutionId: ctx.institutionId,
      target: { in: targets },
      publishAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ pinned: "desc" }, { publishAt: "desc" }],
    take: 100,
  });
  const active = (await decorateAnnouncementLifecycle(db, ctx.institutionId, rows))
    .filter((row) => !row.archived)
    .slice(0, 30);

  return {
    data: active.map((a) => ({
      id: a.id,
      title: a.title,
      message: a.message,
      type: a.type,
      priority: a.priority,
      pinned: a.pinned,
      publishAt: a.publishAt,
      expiresAt: a.expiresAt,
    })),
  };
});
