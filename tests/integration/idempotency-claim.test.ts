import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  sweepExpiredIdempotencyRecords,
} from "@/lib/idempotency";

const institutionPrefix = "phase28-idempotency-";
const scope = "PHASE28_CONCURRENCY_TEST";

function expiry() {
  return new Date(Date.now() + 60_000);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const lifecycleNow = new Date("2099-01-01T00:00:00.000Z");
const expiredAt = new Date("2098-12-31T23:59:00.000Z");
const renewedAt = new Date("2099-01-02T00:00:00.000Z");

afterAll(async () => {
  await db.payment.deleteMany({
    where: { institutionId: { startsWith: institutionPrefix } },
  });
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

  test("expired completed key is reclaimed instead of replaying stale response", async () => {
    const institutionId = `${institutionPrefix}expired-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;

    await db.idempotencyRecord.create({
      data: {
        institutionId,
        scope,
        key,
        responseJson: JSON.stringify({ generation: "old" }),
        expiresAt: expiredAt,
      },
    });

    await db.$transaction(async (tx) => {
      const claim = await claimIdempotencyKey({
        client: tx,
        institutionId,
        scope,
        key,
        now: lifecycleNow,
        expiresAt: renewedAt,
      });
      expect(claim.state).toBe("CLAIMED");

      const row = await tx.idempotencyRecord.findUnique({
        where: { institutionId_scope_key: { institutionId, scope, key } },
      });
      expect(row?.responseJson).toBeNull();
      expect(row?.expiresAt.toISOString()).toBe(renewedAt.toISOString());

      await completeIdempotencyKey({
        client: tx,
        institutionId,
        scope,
        key,
        payload: { generation: "new" },
      });
    });

    const row = await db.idempotencyRecord.findUnique({
      where: { institutionId_scope_key: { institutionId, scope, key } },
    });
    expect(JSON.parse(row?.responseJson ?? "null")).toEqual({ generation: "new" });
  });

  test("unexpired completed key still replays its stored response", async () => {
    const institutionId = `${institutionPrefix}live-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;
    const payload = { generation: "current" };

    await db.idempotencyRecord.create({
      data: {
        institutionId,
        scope,
        key,
        responseJson: JSON.stringify(payload),
        expiresAt: renewedAt,
      },
    });

    const claim = await db.$transaction((tx) =>
      claimIdempotencyKey({
        client: tx,
        institutionId,
        scope,
        key,
        now: lifecycleNow,
        expiresAt: new Date("2099-01-03T00:00:00.000Z"),
      })
    );

    expect(claim.state).toBe("REPLAY");
    if (claim.state === "REPLAY") expect(claim.payload).toEqual(payload);
  });

  test("two transactions racing to reclaim one expired key produce one winner and one replay", async () => {
    const institutionId = `${institutionPrefix}expired-race-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;

    await db.idempotencyRecord.create({
      data: {
        institutionId,
        scope,
        key,
        responseJson: JSON.stringify({ stale: true }),
        expiresAt: expiredAt,
      },
    });

    const reclaim = (marker: string) =>
      db.$transaction(
        async (tx) => {
          const claim = await claimIdempotencyKey({
            client: tx,
            institutionId,
            scope,
            key,
            now: lifecycleNow,
            expiresAt: renewedAt,
          });
          if (claim.state !== "CLAIMED") return claim;

          await new Promise((resolve) => setTimeout(resolve, 100));
          const payload = { marker, recovered: true };
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

    const results = await Promise.all([reclaim("A"), reclaim("B")]);
    const winner = results.find((result) => result.state === "CLAIMED");
    const replay = results.find((result) => result.state === "REPLAY");

    expect(winner?.state).toBe("CLAIMED");
    expect(replay?.state).toBe("REPLAY");
    expect(results.some((result) => result.state === "IN_PROGRESS")).toBe(false);
    if (winner?.state === "CLAIMED" && replay?.state === "REPLAY") {
      expect(replay.payload).toEqual(winner.payload);
    }

    const rows = await db.idempotencyRecord.findMany({ where: { institutionId, scope, key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt.toISOString()).toBe(renewedAt.toISOString());
  });

  test("payment history can retain the same client key across separate expiry windows", async () => {
    const institutionId = `${institutionPrefix}payment-reuse-${crypto.randomUUID()}`;
    const key = `payment-${crypto.randomUUID()}`;

    await db.payment.createMany({
      data: [
        {
          institutionId,
          displayNumber: `PAY-209901-A-${crypto.randomUUID()}`,
          residentId: `resident-${crypto.randomUUID()}`,
          amountMinor: 100,
          method: "CASH",
          status: "PENDING",
          idempotencyKey: key,
        },
        {
          institutionId,
          displayNumber: `PAY-209901-B-${crypto.randomUUID()}`,
          residentId: `resident-${crypto.randomUUID()}`,
          amountMinor: 200,
          method: "UPI",
          status: "PENDING",
          idempotencyKey: key,
        },
      ],
    });

    const rows = await db.payment.findMany({ where: { institutionId, idempotencyKey: key } });
    expect(rows).toHaveLength(2);
  });

  test("rejects an already-expired replacement window", async () => {
    const institutionId = `${institutionPrefix}invalid-expiry-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;

    await expect(
      db.$transaction((tx) =>
        claimIdempotencyKey({
          client: tx,
          institutionId,
          scope,
          key,
          now: lifecycleNow,
          expiresAt: expiredAt,
        })
      )
    ).rejects.toThrow("IDEMPOTENCY_EXPIRY_MUST_BE_FUTURE");
  });

  test("retention sweep is bounded and cannot cross institution boundaries", async () => {
    const institutionId = `${institutionPrefix}sweep-${crypto.randomUUID()}`;
    const otherInstitutionId = `${institutionPrefix}sweep-other-${crypto.randomUUID()}`;

    await db.idempotencyRecord.createMany({
      data: [
        ...Array.from({ length: 4 }, (_, index) => ({
          institutionId,
          scope,
          key: `expired-${index}-${crypto.randomUUID()}`,
          responseJson: JSON.stringify({ index }),
          expiresAt: new Date(expiredAt.getTime() - index * 1000),
        })),
        {
          institutionId,
          scope,
          key: `live-${crypto.randomUUID()}`,
          responseJson: JSON.stringify({ live: true }),
          expiresAt: renewedAt,
        },
        {
          institutionId: otherInstitutionId,
          scope,
          key: `other-expired-${crypto.randomUUID()}`,
          responseJson: JSON.stringify({ other: true }),
          expiresAt: expiredAt,
        },
      ],
    });

    const firstDeleted = await sweepExpiredIdempotencyRecords({
      institutionId,
      now: lifecycleNow,
      limit: 2,
    });
    expect(firstDeleted).toBe(2);
    expect(
      await db.idempotencyRecord.count({
        where: { institutionId, expiresAt: { lte: lifecycleNow } },
      })
    ).toBe(2);
    expect(await db.idempotencyRecord.count({ where: { institutionId: otherInstitutionId } })).toBe(1);

    const secondDeleted = await sweepExpiredIdempotencyRecords({
      institutionId,
      now: lifecycleNow,
      limit: 10,
    });
    expect(secondDeleted).toBe(2);
    expect(
      await db.idempotencyRecord.count({
        where: { institutionId, expiresAt: { lte: lifecycleNow } },
      })
    ).toBe(0);
    expect(await db.idempotencyRecord.count({ where: { institutionId } })).toBe(1);
    expect(await db.idempotencyRecord.count({ where: { institutionId: otherInstitutionId } })).toBe(1);
  });

  test("retention sweep skips an expired row while another transaction is reclaiming it", async () => {
    const institutionId = `${institutionPrefix}sweep-lock-${crypto.randomUUID()}`;
    const key = `claim-${crypto.randomUUID()}`;
    const lockAcquired = deferred();
    const releaseClaim = deferred();

    await db.idempotencyRecord.create({
      data: {
        institutionId,
        scope,
        key,
        responseJson: JSON.stringify({ stale: true }),
        expiresAt: expiredAt,
      },
    });

    const claimant = db.$transaction(
      async (tx) => {
        const claim = await claimIdempotencyKey({
          client: tx,
          institutionId,
          scope,
          key,
          now: lifecycleNow,
          expiresAt: renewedAt,
        });
        expect(claim.state).toBe("CLAIMED");
        lockAcquired.resolve();

        await releaseClaim.promise;
        await completeIdempotencyKey({
          client: tx,
          institutionId,
          scope,
          key,
          payload: { recovered: true },
        });
      },
      { timeout: 10_000 }
    );

    await lockAcquired.promise;
    const deleted = await sweepExpiredIdempotencyRecords({
      institutionId,
      now: lifecycleNow,
      limit: 10,
    });
    expect(deleted).toBe(0);

    releaseClaim.resolve();
    await claimant;

    const row = await db.idempotencyRecord.findUnique({
      where: { institutionId_scope_key: { institutionId, scope, key } },
    });
    expect(row?.expiresAt.toISOString()).toBe(renewedAt.toISOString());
    expect(JSON.parse(row?.responseJson ?? "null")).toEqual({ recovered: true });
  });
});
