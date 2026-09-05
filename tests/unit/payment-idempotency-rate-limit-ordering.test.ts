import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/app/api/v1/payments/route.ts", import.meta.url),
  "utf8"
);

describe("payment idempotency and rate-limit ordering", () => {
  test("completed replays happen before quota consumption while in-progress requests remain limited", () => {
    const scopedReplay = source.indexOf(
      "return { data: JSON.parse(existing.responseJson), meta: { idempotentReplay: true } }"
    );
    const legacyReplay = source.indexOf(
      "return { data: payload, meta: { idempotentReplay: true } }"
    );
    const legacyInProgressDetected = source.indexOf(
      "legacyInProgress = Boolean(ownedLegacyPayment)"
    );
    const limiter = source.indexOf(
      'const rl = await rateLimit(clientKey(ctx.req, "payment-submit"), 10, 60 * 60 * 1000)'
    );
    const legacyConflict = source.indexOf("if (legacyInProgress) {");
    const proofStorage = source.indexOf(
      "const proofFile = proof ? await storeUpload(proof, ctx.institutionId, ctx.user.id) : null"
    );

    expect(scopedReplay).toBeGreaterThan(-1);
    expect(legacyReplay).toBeGreaterThan(-1);
    expect(legacyInProgressDetected).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(scopedReplay);
    expect(limiter).toBeGreaterThan(legacyReplay);
    expect(limiter).toBeGreaterThan(legacyInProgressDetected);
    expect(legacyConflict).toBeGreaterThan(limiter);
    expect(proofStorage).toBeGreaterThan(legacyConflict);

    const limiterCalls = source.match(
      /rateLimit\(clientKey\(ctx\.req, "payment-submit"\), 10, 60 \* 60 \* 1000\)/g
    );
    expect(limiterCalls).toHaveLength(1);
  });
});
