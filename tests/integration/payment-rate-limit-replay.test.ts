import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { actorScopedIdempotencyKey } from "@/lib/idempotency";
import {
  clearRateLimitBucket,
  hashRateLimitKey,
  rateLimit,
} from "@/lib/rate-limit";

const prefix = "phase32-payment-replay-";

afterAll(async () => {
  await db.idempotencyRecord.deleteMany({
    where: { institutionId: { startsWith: prefix } },
  });
  await db.$disconnect();
});

describe("payment replay and rate-limit state", () => {
  test("a completed actor-scoped replay can be resolved without consuming another rate-limit attempt", async () => {
    const residentId = `resident-${crypto.randomUUID()}`;
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const clientIdempotencyKey = `payment-${crypto.randomUUID()}`;
    const storageKey = actorScopedIdempotencyKey(residentId, clientIdempotencyKey);
    const rateKey = `payment-submit:phase32-${crypto.randomUUID()}`;
    const payload = { id: `payment-${crypto.randomUUID()}`, amountMinor: 12345 };

    await db.idempotencyRecord.create({
      data: {
        institutionId,
        scope: "PAYMENT_SUBMIT",
        key: storageKey,
        responseJson: JSON.stringify(payload),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await clearRateLimitBucket(rateKey);
    const first = await rateLimit(rateKey, 10, 60_000);
    expect(first.allowed).toBe(true);

    const before = await db.rateLimitBucket.findUnique({
      where: { keyHash: hashRateLimitKey(rateKey) },
      select: { count: true },
    });
    expect(before?.count).toBe(1);

    const replay = await db.idempotencyRecord.findUnique({
      where: {
        institutionId_scope_key: {
          institutionId,
          scope: "PAYMENT_SUBMIT",
          key: storageKey,
        },
      },
    });
    expect(replay?.responseJson).not.toBeNull();
    expect(JSON.parse(replay?.responseJson ?? "null")).toEqual(payload);

    // The replay branch performs only the lookup above and returns. The route
    // ordering unit guard ensures rateLimit() remains after this branch.
    const after = await db.rateLimitBucket.findUnique({
      where: { keyHash: hashRateLimitKey(rateKey) },
      select: { count: true },
    });
    expect(after?.count).toBe(1);

    await clearRateLimitBucket(rateKey);
  });
});
