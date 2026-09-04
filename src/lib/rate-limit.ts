/**
 * RATE LIMITING — in-memory sliding window (Redis would be the production
 * transport; losing it never corrupts data — spec §6, §83).
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Increment a bucket without checking (used for failure-only counters). */
export function rateLimitCount(key: string, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    bucket.count += 1;
  }
}

/** Check a bucket without incrementing (companion to rateLimitCount). */
export function rateLimitCheck(key: string, max: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) return { allowed: true, retryAfterSec: 0 };
  if (bucket.count >= max) return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  return { allowed: true, retryAfterSec: 0 };
}

/** Client IP as seen behind the gateway (Caddy overwrites X-Forwarded-For). */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export function clientKey(req: Request, scope: string): string {
  return `${scope}:${clientIp(req)}`;
}
