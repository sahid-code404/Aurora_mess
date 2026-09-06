import { describe, expect, test } from "bun:test";
import {
  idempotencyRequestFingerprint,
  parseIdempotencyReplay,
} from "@/lib/idempotency";

describe("idempotency request fingerprints", () => {
  test("canonical hashing ignores object key order but preserves business values", () => {
    const first = idempotencyRequestFingerprint({
      amountMinor: 12500,
      method: "UPI",
      metadata: { note: "Lunch", reference: "abc" },
    });
    const reordered = idempotencyRequestFingerprint({
      metadata: { reference: "abc", note: "Lunch" },
      method: "UPI",
      amountMinor: 12500,
    });
    const changed = idempotencyRequestFingerprint({
      metadata: { reference: "abc", note: "Lunch" },
      method: "UPI",
      amountMinor: 13000,
    });

    expect(first).toHaveLength(64);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  test("legacy plain replay payloads remain compatible during the expiry window", () => {
    const payload = { id: "legacy-payment", amountMinor: 1000 };
    const replay = parseIdempotencyReplay(JSON.stringify(payload), "new-fingerprint");
    expect(replay).toEqual({ state: "REPLAY", payload });
  });
});
