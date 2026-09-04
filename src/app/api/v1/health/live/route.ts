/**
 * GET /api/v1/health/live — liveness probe. Never touches the database.
 */
import { route } from "@/lib/auth/guard";

export const GET = route({ auth: "PUBLIC" }, async () => ({ data: { ok: true } }));
