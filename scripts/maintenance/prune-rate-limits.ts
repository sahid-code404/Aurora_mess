import { db } from "@/lib/db";
import { cleanupExpiredRateLimitBuckets } from "@/lib/rate-limit";

try {
  const deleted = await cleanupExpiredRateLimitBuckets();
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "boardops",
      event: "rate_limit_cleanup",
      deleted,
    })
  );
} finally {
  await db.$disconnect();
}
