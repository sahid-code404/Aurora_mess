import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  idempotencyRequestHash,
  inspectIdempotencyRecord,
} from "@/lib/idempotency";

const prefix = "phase37-payload-";
const scope = "PHASE37_PAYLOAD_TEST";

function institutionId(label: string): string {
  return `${prefix}${label}-${crypto.randomUUID()}`;
}

function key(): string {
  return `key-${crypto.randomUUID()}`;
}

function future(): Date {
  return new Date(Date.now() + 60_000);
}

afterAll(async () => {
  await db.idempotencyRecord.deleteMany({
    where: { institutionId: { startsWith: prefix } },
  });
  await db.$disconnect();
});

describe("payload-bound idempotency", () => {
  test("request hashes are stable across object key order and change with business facts", () => {
    const first = idempotencyRequestHash({
      amountMinor: 12_345,
      method: "UPI",
      proof: { sha256: "abc", size: 123 },
    });
    const reordered = idempotencyRequestHash({
      proof: { size: 123, sha256: "abc" },
      method: "UPI",
      amountMinor: 12_345,
    });
    const changed = idempotencyRequestHash({
      proof: { size: 123, sha256: "abc" },
      method: "UPI",
      amountMinor: 12_346,
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test("same active key and same request hash replays the exact completed payload", async () => {
    const institution = institutionId("same");
    const idempotencyKey = key();
    const requestHash = idempotencyRequestHash({ quantity: 2, mealInstanceId: "meal-a" });
    const payload = { id: "guest-a", quantity: 2 };

    await db.$transaction(async (tx) => {
      const first = await claimIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash,
        expiresAt: future(),
      });
      expect(first.state).toBe("CLAIMED");
      await completeIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash,
        payload,
      });
    });

    const replay = await db.$transaction((tx) =>
      claimIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash,
        expiresAt: future(),
      })
    );

    expect(replay.state).toBe("REPLAY");
    if (replay.state === "REPLAY") expect(replay.payload).toEqual(payload);
  });

  test("same active key with different request data is a mismatch, never a replay", async () => {
    const institution = institutionId("mismatch");
    const idempotencyKey = key();
    const originalHash = idempotencyRequestHash({ amountMinor: 10_000, method: "UPI" });
    const changedHash = idempotencyRequestHash({ amountMinor: 20_000, method: "UPI" });

    await db.$transaction(async (tx) => {
      const first = await claimIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash: originalHash,
        expiresAt: future(),
      });
      expect(first.state).toBe("CLAIMED");
      await completeIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash: originalHash,
        payload: { id: "payment-original", amountMinor: 10_000 },
      });
    });

    const changed = await db.$transaction((tx) =>
      claimIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash: changedHash,
        expiresAt: future(),
      })
    );
    expect(changed.state).toBe("MISMATCH");
  });

  test("expired keys start a new fingerprint window and may represent different data", async () => {
    const institution = institutionId("expired");
    const idempotencyKey = key();
    const now = new Date("2099-01-01T00:00:00.000Z");
    const expired = new Date("2098-12-31T23:00:00.000Z");
    const renewed = new Date("2099-01-02T00:00:00.000Z");
    const newHash = idempotencyRequestHash({ amountMinor: 99_000 });

    await db.idempotencyRecord.create({
      data: {
        institutionId: institution,
        scope,
        key: idempotencyKey,
        responseJson: JSON.stringify({ id: "old-payment", amountMinor: 1_000 }),
        expiresAt: expired,
      },
    });

    await db.$transaction(async (tx) => {
      const reclaimed = await claimIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash: newHash,
        now,
        expiresAt: renewed,
      });
      expect(reclaimed.state).toBe("CLAIMED");

      const row = await tx.idempotencyRecord.findUniqueOrThrow({
        where: { institutionId_scope_key: { institutionId: institution, scope, key: idempotencyKey } },
      });
      expect(inspectIdempotencyRecord(row.responseJson, newHash).state).toBe("IN_PROGRESS");

      await completeIdempotencyKey({
        client: tx,
        institutionId: institution,
        scope,
        key: idempotencyKey,
        requestHash: newHash,
        payload: { id: "new-payment", amountMinor: 99_000 },
      });
    });

    const row = await db.idempotencyRecord.findUniqueOrThrow({
      where: { institutionId_scope_key: { institutionId: institution, scope, key: idempotencyKey } },
    });
    expect(inspectIdempotencyRecord(row.responseJson, newHash).state).toBe("REPLAY");
  });

  test("concurrent same-key requests with different payloads produce one winner and one mismatch", async () => {
    const institution = institutionId("race");
    const idempotencyKey = key();
    const hashA = idempotencyRequestHash({ amountMinor: 1_000, reference: "A" });
    const hashB = idempotencyRequestHash({ amountMinor: 2_000, reference: "B" });

    const submit = (requestHash: string, marker: string) =>
      db.$transaction(
        async (tx) => {
          const claim = await claimIdempotencyKey({
            client: tx,
            institutionId: institution,
            scope,
            key: idempotencyKey,
            requestHash,
            expiresAt: future(),
          });
          if (claim.state !== "CLAIMED") return claim;

          await new Promise((resolve) => setTimeout(resolve, 100));
          await completeIdempotencyKey({
            client: tx,
            institutionId: institution,
            scope,
            key: idempotencyKey,
            requestHash,
            payload: { marker },
          });
          return { state: "CLAIMED" as const, marker };
        },
        { timeout: 10_000 }
      );

    const results = await Promise.all([submit(hashA, "A"), submit(hashB, "B")]);
    expect(results.filter((result) => result.state === "CLAIMED")).toHaveLength(1);
    expect(results.filter((result) => result.state === "MISMATCH")).toHaveLength(1);
    expect(results.some((result) => result.state === "REPLAY")).toBe(false);
  });

  test("historical raw completed payloads remain replay-compatible during their expiry window", () => {
    const legacy = { id: "legacy-payment", amountMinor: 5_000 };
    const inspected = inspectIdempotencyRecord(
      JSON.stringify(legacy),
      idempotencyRequestHash({ amountMinor: 99_999 })
    );

    expect(inspected.state).toBe("REPLAY");
    if (inspected.state === "REPLAY") {
      expect(inspected.legacy).toBe(true);
      expect(inspected.payload).toEqual(legacy);
    }
  });
});