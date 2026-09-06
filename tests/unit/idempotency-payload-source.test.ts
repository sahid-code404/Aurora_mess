import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const idempotencySource = readFileSync(
  new URL("../../src/lib/idempotency.ts", import.meta.url),
  "utf8"
);
const paymentSource = readFileSync(
  new URL("../../src/app/api/v1/payments/route.ts", import.meta.url),
  "utf8"
);
const guestSource = readFileSync(
  new URL("../../src/app/api/v1/guest-meals/route.ts", import.meta.url),
  "utf8"
);

describe("payload-bound idempotency source guards", () => {
  test("claims persist a versioned request fingerprint envelope from IN_PROGRESS through COMPLETED", () => {
    expect(idempotencySource).toContain('const IDEMPOTENCY_ENVELOPE = "BOARDOPS_IDEMPOTENCY_V1";');
    expect(idempotencySource).toContain('state: "IN_PROGRESS"');
    expect(idempotencySource).toContain('state: "COMPLETED"');
    expect(idempotencySource).toContain('if (requestHash && parsed.requestHash !== requestHash) return { state: "MISMATCH" };');
    expect(idempotencySource).toContain("responseJson: inProgressJson");
  });

  test("payment fingerprint covers money fields and actual proof bytes before fast replay", () => {
    const hashAt = paymentSource.indexOf("requestHash = idempotencyRequestHash({");
    const inspectAt = paymentSource.indexOf("inspectIdempotencyRecord(existing.responseJson, requestHash)");
    const claimAt = paymentSource.indexOf("claimIdempotencyKey({");
    expect(hashAt).toBeGreaterThan(0);
    expect(inspectAt).toBeGreaterThan(hashAt);
    expect(claimAt).toBeGreaterThan(inspectAt);
    expect(paymentSource).toContain('createHash("sha256").update(Buffer.from(await proof.arrayBuffer())).digest("hex")');
    expect(paymentSource).toContain("amountMinor: amountMinor as number");
    expect(paymentSource).toContain("method: method.data!");
    expect(paymentSource).toContain("reference: reference ?? null");
    expect(paymentSource).toContain("notes: notes ?? null");
    expect(paymentSource).toContain("requestHash,");
  });

  test("guest booking fingerprint covers target, quantity and normalized note", () => {
    expect(guestSource).toContain("mealInstanceId: body.mealInstanceId");
    expect(guestSource).toContain("quantity: body.quantity");
    expect(guestSource).toContain("note: body.note ?? null");
    expect(guestSource).toContain('if (claim.state === "MISMATCH") throw idempotencyPayloadMismatch();');
    expect(guestSource).toContain("requestHash,");
  });
});