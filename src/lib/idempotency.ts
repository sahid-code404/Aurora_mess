import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type IdempotencyClient = Pick<Prisma.TransactionClient, "idempotencyRecord">;

type ClaimResult =
  | { state: "CLAIMED" }
  | { state: "REPLAY"; payload: Record<string, unknown> }
  | { state: "MISMATCH" }
  | { state: "IN_PROGRESS" };

type ReplayResult =
  | { state: "REPLAY"; payload: Record<string, unknown> }
  | { state: "MISMATCH" };

const ENVELOPE_VERSION = 1;
const ENVELOPE_KEY = "__boardopsIdempotency";

type ReplayEnvelope = {
  [ENVELOPE_KEY]: {
    version: number;
    requestFingerprint: string;
  };
  payload: Record<string, unknown>;
};

function normalizeFingerprintValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("IDEMPOTENCY_FINGERPRINT_NON_FINITE_NUMBER");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      normalized[key] = normalizeFingerprintValue(record[key]);
    }
    return normalized;
  }
  throw new Error("IDEMPOTENCY_FINGERPRINT_UNSUPPORTED_VALUE");
}

/**
 * Hash one canonical business-request shape. Object key ordering never changes
 * the result; raw request values are never persisted in the idempotency table.
 */
export function idempotencyRequestFingerprint(value: unknown): string {
  const canonical = JSON.stringify(normalizeFingerprintValue(value));
  return createHash("sha256").update(canonical).digest("hex");
}

function isReplayEnvelope(value: unknown): value is ReplayEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const metadata = record[ENVELOPE_KEY];
  const payload = record.payload;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const metaRecord = metadata as Record<string, unknown>;
  return (
    metaRecord.version === ENVELOPE_VERSION &&
    typeof metaRecord.requestFingerprint === "string" &&
    metaRecord.requestFingerprint.length === 64
  );
}

/**
 * Decode a completed replay row. New rows carry a fingerprint envelope; legacy
 * rows remain plain payload JSON and replay unchanged until their normal expiry.
 */
export function parseIdempotencyReplay(
  responseJson: string,
  requestFingerprint?: string | null
): ReplayResult {
  const parsed = JSON.parse(responseJson) as unknown;
  if (isReplayEnvelope(parsed)) {
    if (
      requestFingerprint &&
      parsed[ENVELOPE_KEY].requestFingerprint !== requestFingerprint
    ) {
      return { state: "MISMATCH" };
    }
    return { state: "REPLAY", payload: parsed.payload };
  }
  return { state: "REPLAY", payload: parsed as Record<string, unknown> };
}

/**
 * Storage keys are derived from the authenticated actor plus the client key.
 * Institution and operation scope remain separate database dimensions.
 *
 * Hashing keeps the persisted key fixed-width and prevents one resident's
 * arbitrary client key from becoming another resident's replay namespace.
 */
export function actorScopedIdempotencyKey(actorUserId: string, clientKey: string): string {
  return createHash("sha256").update(actorUserId).update("\0").update(clientKey).digest("hex");
}

export async function claimIdempotencyKey(input: {
  client: IdempotencyClient;
  institutionId: string;
  scope: string;
  key: string;
  expiresAt: Date;
  now?: Date;
  requestFingerprint?: string | null;
}): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new Error("IDEMPOTENCY_EXPIRY_MUST_BE_FUTURE");
  }

  const created = await input.client.idempotencyRecord.createMany({
    data: [
      {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
        responseJson: null,
        expiresAt: input.expiresAt,
      },
    ],
    // PostgreSQL translates this into ON CONFLICT DO NOTHING. Unlike catching a
    // unique-constraint exception inside an interactive transaction, this does
    // not poison the transaction and is therefore safe to inspect afterwards.
    skipDuplicates: true,
  });

  if (created.count === 1) return { state: "CLAIMED" };

  // The key already exists. Expiry is part of the lifecycle, not informational
  // metadata: exactly one caller may atomically reclaim an expired key. The
  // conditional UPDATE is safe under PostgreSQL READ COMMITTED semantics. If
  // another transaction renews the row first, this update affects zero rows and
  // the loser falls through to the winner's current state below.
  const reclaimed = await input.client.idempotencyRecord.updateMany({
    where: {
      institutionId: input.institutionId,
      scope: input.scope,
      key: input.key,
      expiresAt: { lte: now },
    },
    data: {
      responseJson: null,
      expiresAt: input.expiresAt,
    },
  });

  if (reclaimed.count === 1) return { state: "CLAIMED" };

  const existing = await input.client.idempotencyRecord.findUnique({
    where: {
      institutionId_scope_key: {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
      },
    },
  });

  // A row can disappear only through maintenance between the conflict and this
  // read. Treat that narrow race as in-progress instead of manufacturing a
  // second logical request; the client can retry safely.
  if (!existing) return { state: "IN_PROGRESS" };

  if (existing.responseJson) {
    return parseIdempotencyReplay(existing.responseJson, input.requestFingerprint);
  }

  // An in-progress request has not produced a replay payload/fingerprint yet.
  // It is always a conflict for a second request; once the winner completes, a
  // retry can distinguish exact replay from key reuse with changed details.
  return { state: "IN_PROGRESS" };
}

export async function completeIdempotencyKey(input: {
  client: IdempotencyClient;
  institutionId: string;
  scope: string;
  key: string;
  payload: Record<string, unknown>;
  requestFingerprint?: string | null;
}) {
  const stored: Record<string, unknown> | ReplayEnvelope = input.requestFingerprint
    ? {
        [ENVELOPE_KEY]: {
          version: ENVELOPE_VERSION,
          requestFingerprint: input.requestFingerprint,
        },
        payload: input.payload,
      }
    : input.payload;

  await input.client.idempotencyRecord.update({
    where: {
      institutionId_scope_key: {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
      },
    },
    data: { responseJson: JSON.stringify(stored) },
  });
}

/**
 * Remove a bounded batch of expired idempotency rows for one institution.
 *
 * FOR UPDATE SKIP LOCKED is deliberate: a request that is actively reclaiming
 * an expired key owns that row lock and maintenance must skip it instead of
 * blocking the business request or deleting underneath it.
 */
export async function sweepExpiredIdempotencyRecords(input: {
  institutionId: string;
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const requestedLimit = input.limit !== undefined && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 100;
  const limit = Math.min(500, Math.max(1, requestedLimit));

  const deleted = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH doomed AS (
      SELECT "id"
      FROM "IdempotencyRecord"
      WHERE "institutionId" = ${input.institutionId}
        AND "expiresAt" <= ${now}
      ORDER BY "expiresAt" ASC, "id" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "IdempotencyRecord" AS target
    USING doomed
    WHERE target."id" = doomed."id"
    RETURNING target."id"
  `);

  return deleted.length;
}
