import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  idempotencyRequestFingerprint,
} from "@/lib/idempotency";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

async function createInstitution() {
  return db.institution.create({
    data: {
      name: unique("Fingerprint Institution"),
      settings: { create: {} },
    },
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("completed idempotency request fingerprint lifecycle", () => {
  test("same key + same payload replays while same key + changed payload conflicts", async () => {
    const institution = await createInstitution();
    const key = unique("fingerprint-key");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const originalFingerprint = idempotencyRequestFingerprint({ quantity: 1, note: "one" });
    const changedFingerprint = idempotencyRequestFingerprint({ quantity: 2, note: "one" });

    await db.$transaction(async (tx) => {
      const claim = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_TEST",
        key,
        expiresAt,
        now,
        requestFingerprint: originalFingerprint,
      });
      expect(claim.state).toBe("CLAIMED");
      await completeIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_TEST",
        key,
        payload: { id: "original", quantity: 1 },
        requestFingerprint: originalFingerprint,
      });
    });

    await db.$transaction(async (tx) => {
      const replay = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_TEST",
        key,
        expiresAt,
        now: new Date(now.getTime() + 1_000),
        requestFingerprint: originalFingerprint,
      });
      expect(replay).toEqual({ state: "REPLAY", payload: { id: "original", quantity: 1 } });
    });

    await db.$transaction(async (tx) => {
      const mismatch = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_TEST",
        key,
        expiresAt,
        now: new Date(now.getTime() + 2_000),
        requestFingerprint: changedFingerprint,
      });
      expect(mismatch).toEqual({ state: "MISMATCH" });
    });
  });

  test("in-progress duplicates stay IN_PROGRESS and an expired key can start a new fingerprint lifecycle", async () => {
    const institution = await createInstitution();
    const key = unique("fingerprint-reclaim");
    const firstNow = new Date();
    const firstFingerprint = idempotencyRequestFingerprint({ amountMinor: 1000 });
    const nextFingerprint = idempotencyRequestFingerprint({ amountMinor: 2000 });

    await db.$transaction(async (tx) => {
      const first = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_RECLAIM",
        key,
        expiresAt: new Date(firstNow.getTime() + 10_000),
        now: firstNow,
        requestFingerprint: firstFingerprint,
      });
      expect(first.state).toBe("CLAIMED");
    });

    await db.$transaction(async (tx) => {
      const inProgress = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_RECLAIM",
        key,
        expiresAt: new Date(firstNow.getTime() + 20_000),
        now: new Date(firstNow.getTime() + 1_000),
        requestFingerprint: nextFingerprint,
      });
      expect(inProgress.state).toBe("IN_PROGRESS");
    });

    const expiredNow = new Date(firstNow.getTime() + 11_000);
    await db.idempotencyRecord.update({
      where: {
        institutionId_scope_key: {
          institutionId: institution.id,
          scope: "FINGERPRINT_RECLAIM",
          key,
        },
      },
      data: { expiresAt: new Date(expiredNow.getTime() - 1) },
    });

    await db.$transaction(async (tx) => {
      const reclaimed = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_RECLAIM",
        key,
        expiresAt: new Date(expiredNow.getTime() + 60_000),
        now: expiredNow,
        requestFingerprint: nextFingerprint,
      });
      expect(reclaimed.state).toBe("CLAIMED");
      await completeIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_RECLAIM",
        key,
        payload: { id: "replacement", amountMinor: 2000 },
        requestFingerprint: nextFingerprint,
      });
    });

    await db.$transaction(async (tx) => {
      const replay = await claimIdempotencyKey({
        client: tx,
        institutionId: institution.id,
        scope: "FINGERPRINT_RECLAIM",
        key,
        expiresAt: new Date(expiredNow.getTime() + 60_000),
        now: new Date(expiredNow.getTime() + 1_000),
        requestFingerprint: nextFingerprint,
      });
      expect(replay).toEqual({
        state: "REPLAY",
        payload: { id: "replacement", amountMinor: 2000 },
      });
    });
  });
});
