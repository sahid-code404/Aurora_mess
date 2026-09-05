import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  cleanupExpiredRateLimitBuckets,
  clearRateLimitBucket,
  hashRateLimitKey,
  rateLimit,
  rateLimitCheck,
  rateLimitCount,
} from "@/lib/rate-limit";

const keys: string[] = [];

function uniqueKey(label: string): string {
  const key = `phase14:${label}:${Date.now()}:${crypto.randomUUID()}`;
  keys.push(key);
  return key;
}

afterAll(async () => {
  await Promise.all(keys.map((key) => clearRateLimitBucket(key)));
});

describe("shared PostgreSQL rate limits", () => {
  test("enforces the exact fixed-window attempt ceiling", async () => {
    const key = uniqueKey("ceiling");

    expect((await rateLimit(key, 2, 60_000)).allowed).toBe(true);
    expect((await rateLimit(key, 2, 60_000)).allowed).toBe(true);

    const blocked = await rateLimit(key, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("failure-only check/count preserves login semantics", async () => {
    const key = uniqueKey("failures-only");

    expect((await rateLimitCheck(key, 2)).allowed).toBe(true);
    await rateLimitCount(key, 60_000);
    expect((await rateLimitCheck(key, 2)).allowed).toBe(true);
    await rateLimitCount(key, 60_000);

    const blocked = await rateLimitCheck(key, 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("concurrent callers share one atomic bucket", async () => {
    const key = uniqueKey("concurrency");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimit(key, 10, 60_000))
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(10);

    const row = await db.rateLimitBucket.findUnique({
      where: { keyHash: hashRateLimitKey(key) },
    });
    expect(row?.count).toBe(20);
  });

  test("persists only a SHA-256 digest, never the raw IP/email-bearing key", async () => {
    const key = uniqueKey("privacy") + ":203.0.113.24:resident@example.test";
    keys.push(key);
    await rateLimit(key, 5, 60_000);

    const digest = hashRateLimitKey(key);
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain("resident@example.test");

    const row = await db.rateLimitBucket.findUnique({ where: { keyHash: digest } });
    expect(row?.keyHash).toBe(digest);
    expect(await db.rateLimitBucket.findUnique({ where: { keyHash: key } })).toBeNull();
  });

  test("expired buckets restart at one and cleanup removes stale rows", async () => {
    const resetKey = uniqueKey("reset");
    await rateLimit(resetKey, 1, 60_000);
    await db.rateLimitBucket.update({
      where: { keyHash: hashRateLimitKey(resetKey) },
      data: { resetAt: new Date(Date.now() - 1_000) },
    });

    const restarted = await rateLimit(resetKey, 1, 60_000);
    expect(restarted.allowed).toBe(true);
    const restartedRow = await db.rateLimitBucket.findUnique({
      where: { keyHash: hashRateLimitKey(resetKey) },
    });
    expect(restartedRow?.count).toBe(1);

    const cleanupKey = uniqueKey("cleanup");
    await rateLimit(cleanupKey, 1, 60_000);
    await db.rateLimitBucket.update({
      where: { keyHash: hashRateLimitKey(cleanupKey) },
      data: { resetAt: new Date(Date.now() - 1_000) },
    });

    expect(await cleanupExpiredRateLimitBuckets()).toBeGreaterThanOrEqual(1);
    expect(
      await db.rateLimitBucket.findUnique({ where: { keyHash: hashRateLimitKey(cleanupKey) } })
    ).toBeNull();
  });
});
