import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/app/api/v1/payments/route.ts", import.meta.url),
  "utf8"
);

describe("payment idempotency and rate-limit ordering", () => {
  test("completed matching replays and payload conflicts resolve before quota consumption while in-progress requests remain limited", () => {
    const scopedInspection = source.indexOf(
      "const inspected = inspectIdempotencyRecord(existing.responseJson, requestHash)"
    );
    const scopedMismatch = source.indexOf(
      'if (inspected.state === "MISMATCH") throw idempotencyPayloadMismatch();'
    );
    const scopedReplay = source.indexOf(
      'if (inspected.state === "REPLAY") {'
    );
    const scopedReplayReturn = source.indexOf(
      "return { data: inspected.payload, meta: { idempotentReplay: true } }"
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

    expect(scopedInspection).toBeGreaterThan(-1);
    expect(scopedMismatch).toBeGreaterThan(scopedInspection);
    expect(scopedReplay).toBeGreaterThan(scopedMismatch);
    expect(scopedReplayReturn).toBeGreaterThan(scopedReplay);
    expect(legacyReplay).toBeGreaterThan(-1);
    expect(legacyInProgressDetected).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(scopedReplayReturn);
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