import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const payment = source("src/app/api/v1/payments/route.ts");
const guest = source("src/app/api/v1/guest-meals/route.ts");

describe("route idempotency fingerprint wiring", () => {
  test("Payment fingerprints validated request details before fast replay and persists the fingerprint on completion", () => {
    const fingerprint = payment.indexOf("const requestFingerprint = idempotencyKey");
    const fastReplay = payment.indexOf("parseIdempotencyReplay(existing.responseJson, requestFingerprint)");
    const claim = payment.indexOf("const claim = await claimIdempotencyKey(");
    const complete = payment.indexOf("await completeIdempotencyKey(");
    expect(fingerprint).toBeGreaterThan(-1);
    expect(fingerprint).toBeLessThan(fastReplay);
    expect(fastReplay).toBeLessThan(claim);
    expect(payment.slice(claim, complete)).toContain("requestFingerprint,");
    expect(payment.slice(complete)).toContain("requestFingerprint,");
    expect(payment).toContain('claim.state === "MISMATCH"');
  });

  test("Guest Meals fingerprints meal instance, quantity and note on fast and transactional replay paths", () => {
    expect(guest).toContain("mealInstanceId: body.mealInstanceId");
    expect(guest).toContain("quantity: body.quantity");
    expect(guest).toContain("note: body.note ?? null");
    expect(guest).toContain("parseIdempotencyReplay(current.responseJson, requestFingerprint)");
    expect(guest).toContain('claim.state === "MISMATCH"');
    const claim = guest.indexOf("const claim = await claimIdempotencyKey(");
    const complete = guest.indexOf("await completeIdempotencyKey(");
    expect(guest.slice(claim, complete)).toContain("requestFingerprint,");
    expect(guest.slice(complete)).toContain("requestFingerprint,");
  });
});
