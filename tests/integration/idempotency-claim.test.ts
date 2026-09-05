import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { claimIdempotencyKey, completeIdempotencyKey } from "@/lib/idempotency";

const institutionPrefix = "phase28-idempotency-";
const scope = "PHASE28_CONCURRENCY_TEST";

function expiry() {
  return new Date(Date.now() + 60_000);
}

afterAll(async () => {
  await db.idempotencyRecord.deleteMany({
    where: { institutionId: { startsWith: institutionPrefix } },
  });
  await db.$disconnect();
});

describe("atomic idempotency claims", () => {
  test("duplicate claim does not poison the PostgreSQL transaction", async () => {
    const institutionId = `${institutionPrefix}usable-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;

    await db.idempotencyRecord.create({
      data: {
        institutionId,
        scope,
        key,
        responseJson: null,
        expiresAt: expiry(),
      },
    });

    await db.$transaction(async (tx) => {
      const claim = await claimIdempotencyKey({
        client: tx,
        institutionId,
        scope,
        key,
        expiresAt: expiry(),
      });
      expect(claim.state).toBe("IN_PROGRESS");

      // A caught P2002 would leave PostgreSQL's transaction aborted here. The
      // conflict-safe createMany path must leave it fully usable.
      const count = await tx.idempotencyRecord.count({
        where: { institutionId, scope, key },
      });
      expect(count).toBe(1);
    });
  });

  test("concurrent transactions produce one winner and one exact replay", async () => {
    const institutionId = `${institutionPrefix}race-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;

    const submit = (marker: string) =>
      db.$transaction(
        async (tx) => {
          const claim = await claimIdempotencyKey({
            client: tx,
            institutionId,
            scope,
            key,
            expiresAt: expiry(),
          });

          if (claim.state !== "CLAIMED") return claim;

          // Keep the winning transaction open briefly so the second transaction
          // has to resolve a real overlapping unique-key conflict.
          await new Promise((resolve) => setTimeout(resolve, 100));
          const payload = { marker, accepted: true };
          await completeIdempotencyKey({
            client: tx,
            institutionId,
            scope,
            key,
            payload,
          });
          return { state: "CLAIMED" as const, payload };
        },
        { timeout: 10_000 }
      );

    const results = await Promise.all([submit("A"), submit("B")]);
    const winner = results.find((result) => result.state === "CLAIMED");
    const replay = results.find((result) => result.state === "REPLAY");

    expect(winner?.state).toBe("CLAIMED");
    expect(replay?.state).toBe("REPLAY");
    expect(results.some((result) => result.state === "IN_PROGRESS")).toBe(false);

    if (winner?.state === "CLAIMED" && replay?.state === "REPLAY") {
      expect(replay.payload).toEqual(winner.payload);
    }

    const rows = await db.idempotencyRecord.findMany({
      where: { institutionId, scope, key },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.responseJson).not.toBeNull();
  });
});
