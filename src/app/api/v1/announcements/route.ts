/**
 * GET /api/v1/announcements — active announcements visible to the signed-in
 * role: target EVERYONE or the caller's role, publishAt <= now, not expired.
 * Pinned first, then newest. Escaped-plain-text only (rendering is client-side).
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const now = new Date();
  const targets =
    ctx.user.role === "ADMIN" ? ["EVERYONE", "ADMINS"] : ["EVERYONE", "RESIDENTS"];

  const rows = await db.announcement.findMany({
    where: {
      institutionId: ctx.institutionId,
      target: { in: targets },
      publishAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ pinned: "desc" }, { publishAt: "desc" }],
    take: 30,
  });

  return {
    data: rows.map((a) => ({
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
