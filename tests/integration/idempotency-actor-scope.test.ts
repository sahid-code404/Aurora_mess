import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  actorScopedIdempotencyKey,
  claimIdempotencyKey,
  completeIdempotencyKey,
} from "@/lib/idempotency";

const institutionPrefix = "phase31-idempotency-scope-";
const scope = "PHASE31_RESIDENT_SCOPE_TEST";

afterAll(async () => {
  await db.idempotencyRecord.deleteMany({
    where: { institutionId: { startsWith: institutionPrefix } },
  });
});

describe("resident-scoped idempotency", () => {
  test("same client key derives stable but different storage keys for different residents", () => {
    const clientKey = "same-client-request-key";
    const residentA = "resident-a";
    const residentB = "resident-b";

    const keyA = actorScopedIdempotencyKey(residentA, clientKey);
    const keyARepeat = actorScopedIdempotencyKey(residentA, clientKey);
    const keyB = actorScopedIdempotencyKey(residentB, clientKey);

    expect(keyA).toBe(keyARepeat);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toHaveLength(64);
    expect(keyB).toHaveLength(64);
    expect(keyA).not.toContain(clientKey);
    expect(keyA).not.toContain(residentA);
  });

  test("two residents may safely claim the same external client key independently", async () => {
    const institutionId = `${institutionPrefix}${crypto.randomUUID()}`;
    const clientKey = `shared-${crypto.randomUUID()}`;
    const keyA = actorScopedIdempotencyKey("resident-a", clientKey);
    const keyB = actorScopedIdempotencyKey("resident-b", clientKey);

    const submit = (key: string, resident: string) =>
      db.$transaction(async (tx) => {
        const claim = await claimIdempotencyKey({
          client: tx,
          institutionId,
          scope,
          key,
          expiresAt: new Date(Date.now() + 60_000),
        });
        expect(claim.state).toBe("CLAIMED");

        const payload = { resident };
        await completeIdempotencyKey({
          client: tx,
          institutionId,
          scope,
          key,
          payload,
        });
        return payload;
      });

    const [payloadA, payloadB] = await Promise.all([
      submit(keyA, "resident-a"),
      submit(keyB, "resident-b"),
    ]);

    expect(payloadA).toEqual({ resident: "resident-a" });
    expect(payloadB).toEqual({ resident: "resident-b" });

    const rows = await db.idempotencyRecord.findMany({
      where: { institutionId, scope },
      orderBy: { key: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key))).toEqual(new Set([keyA, keyB]));
    expect(new Set(rows.map((row) => JSON.parse(row.responseJson ?? "null").resident))).toEqual(
      new Set(["resident-a", "resident-b"])
    );
  });
});
