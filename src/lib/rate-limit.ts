import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * RATE LIMITING — PostgreSQL-backed fixed windows shared by every app instance.
 *
 * The public API intentionally stays policy-agnostic: routes continue choosing
 * their own max/window values. Only the transport changed from process memory
 * to PostgreSQL so horizontal replicas observe the same counters.
 *
 * Raw keys can contain IPs or emails. They are SHA-256 hashed before storage so
 * the rate-limit table never persists those identifiers in plaintext.
 */

type RateLimitResult = { allowed: boolean; retryAfterSec: number };
type BucketRow = { count: number; resetAt: Date };

function assertPolicy(max: number, windowMs: number): void {
  if (!Number.isInteger(max) || max < 1) throw new Error("Rate-limit max must be a positive integer.");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("Rate-limit window must be positive.");
}

export function hashRateLimitKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toResult(row: BucketRow | undefined, max: number, now: Date): RateLimitResult {
  if (!row || row.resetAt <= now) return { allowed: true, retryAfterSec: 0 };
  const allowed = row.count <= max;
  return {
    allowed,
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000)),
  };
}

async function incrementBucket(key: string, windowMs: number): Promise<BucketRow> {
  const now = new Date();
  const nextResetAt = new Date(now.getTime() + windowMs);
  const keyHash = hashRateLimitKey(key);

  const rows = await db.$queryRaw<BucketRow[]>(Prisma.sql`
    INSERT INTO "RateLimitBucket" ("keyHash", "count", "resetAt", "updatedAt")
    VALUES (${keyHash}, 1, ${nextResetAt}, ${now})
    ON CONFLICT ("keyHash") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."resetAt" <= ${now} THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "resetAt" = CASE
        WHEN "RateLimitBucket"."resetAt" <= ${now} THEN ${nextResetAt}
        ELSE "RateLimitBucket"."resetAt"
      END,
      "updatedAt" = ${now}
    RETURNING "count", "resetAt"
  `);

  const row = rows[0];
  if (!row) throw new Error("Rate-limit bucket update returned no row.");
  return row;
}

/** Consume one attempt from a fixed window. */
export async function rateLimit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  assertPolicy(max, windowMs);
  const now = new Date();
  const row = await incrementBucket(key, windowMs);
  return toResult(row, max, now);
}

/** Increment a bucket without checking (used for failure-only counters). */
export async function rateLimitCount(key: string, windowMs: number): Promise<void> {
  assertPolicy(1, windowMs);
  await incrementBucket(key, windowMs);
}

/** Check a bucket without incrementing (companion to rateLimitCount). */
export async function rateLimitCheck(key: string, max: number): Promise<RateLimitResult> {
  if (!Number.isInteger(max) || max < 1) throw new Error("Rate-limit max must be a positive integer.");
  const now = new Date();
  const keyHash = hashRateLimitKey(key);
  const rows = await db.$queryRaw<BucketRow[]>(Prisma.sql`
    SELECT "count", "resetAt"
    FROM "RateLimitBucket"
    WHERE "keyHash" = ${keyHash}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row || row.resetAt <= now) return { allowed: true, retryAfterSec: 0 };
  if (row.count >= max) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Explicit cleanup hook for maintenance/tests; normal requests never scan the table. */
export async function cleanupExpiredRateLimitBuckets(before = new Date()): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    DELETE FROM "RateLimitBucket"
    WHERE "resetAt" <= ${before}
  `);
}

/** Test/administrative helper for clearing a single hashed bucket. */
export async function clearRateLimitBucket(key: string): Promise<void> {
  const keyHash = hashRateLimitKey(key);
  await db.$executeRaw(Prisma.sql`
    DELETE FROM "RateLimitBucket"
    WHERE "keyHash" = ${keyHash}
  `);
}

/** Client IP as seen behind the gateway (Caddy overwrites X-Forwarded-For). */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export function clientKey(req: Request, scope: string): string {
  return `${scope}:${clientIp(req)}`;
}
