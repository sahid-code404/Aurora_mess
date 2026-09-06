import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type IdempotencyClient = Pick<Prisma.TransactionClient, "idempotencyRecord">;

export type IdempotencyInspection =
  | { state: "REPLAY"; payload: Record<string, unknown>; legacy: boolean }
  | { state: "IN_PROGRESS" }
  | { state: "MISMATCH" };

type ClaimResult =
  | { state: "CLAIMED" }
  | { state: "REPLAY"; payload: Record<string, unknown> }
  | { state: "IN_PROGRESS" }
  | { state: "MISMATCH" };

const IDEMPOTENCY_ENVELOPE = "BOARDOPS_IDEMPOTENCY_V1";

type IdempotencyEnvelope = {
  __boardopsIdempotency: typeof IDEMPOTENCY_ENVELOPE;
  requestHash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  payload?: Record<string, unknown>;
};

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("IDEMPOTENCY_REQUEST_HASH_NON_FINITE_NUMBER");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      target[key] = canonicalize(source[key]);
    }
    return target;
  }
  throw new Error("IDEMPOTENCY_REQUEST_HASH_UNSUPPORTED_VALUE");
}

/**
 * Stable SHA-256 of normalized business-request facts.
 *
 * Callers should pass only fields that determine the side effect. Key order is
 * canonicalized recursively so logically identical objects hash identically.
 */
export function idempotencyRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
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

function encodeEnvelope(input: {
  requestHash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  payload?: Record<string, unknown>;
}): string {
  const envelope: IdempotencyEnvelope = {
    __boardopsIdempotency: IDEMPOTENCY_ENVELOPE,
    requestHash: input.requestHash,
    state: input.state,
    ...(input.payload ? { payload: input.payload } : {}),
  };
  return JSON.stringify(envelope);
}

function isEnvelope(value: unknown): value is IdempotencyEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IdempotencyEnvelope>;
  return (
    candidate.__boardopsIdempotency === IDEMPOTENCY_ENVELOPE &&
    typeof candidate.requestHash === "string" &&
    (candidate.state === "IN_PROGRESS" || candidate.state === "COMPLETED")
  );
}

/**
 * Interpret persisted idempotency state without exposing the internal envelope
 * to API callers. Historical pre-Phase-37 response JSON is intentionally
 * replay-compatible because its original request fingerprint is unknowable; it
 * disappears naturally through the existing 24-hour expiry lifecycle.
 */
export function inspectIdempotencyRecord(
  responseJson: string | null,
  requestHash?: string
): IdempotencyInspection {
  if (!responseJson) return { state: "IN_PROGRESS" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    return { state: "IN_PROGRESS" };
  }

  if (isEnvelope(parsed)) {
    if (requestHash && parsed.requestHash !== requestHash) return { state: "MISMATCH" };
    if (parsed.state === "COMPLETED" && parsed.payload && typeof parsed.payload === "object") {
      return { state: "REPLAY", payload: parsed.payload, legacy: false };
    }
    return { state: "IN_PROGRESS" };
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { state: "REPLAY", payload: parsed as Record<string, unknown>, legacy: true };
  }

  return { state: "IN_PROGRESS" };
}

export async function claimIdempotencyKey(input: {
  client: IdempotencyClient;
  institutionId: string;
  scope: string;
  key: string;
  expiresAt: Date;
  requestHash?: string;
  now?: Date;
}): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new Error("IDEMPOTENCY_EXPIRY_MUST_BE_FUTURE");
  }

  const inProgressJson = input.requestHash
    ? encodeEnvelope({ requestHash: input.requestHash, state: "IN_PROGRESS" })
    : null;

  const created = await input.client.idempotencyRecord.createMany({
    data: [
      {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
        responseJson: inProgressJson,
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
  // metadata: exactly one caller may atomically reclaim an expired key. Reclaim
  // also replaces the old request fingerprint, because an expired key starts a
  // new idempotency window and may legitimately represent a different request.
  const reclaimed = await input.client.idempotencyRecord.updateMany({
    where: {
      institutionId: input.institutionId,
      scope: input.scope,
      key: input.key,
      expiresAt: { lte: now },
    },
    data: {
      responseJson: inProgressJson,
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

  const inspected = inspectIdempotencyRecord(existing.responseJson, input.requestHash);
  if (inspected.state === "REPLAY") {
    return { state: "REPLAY", payload: inspected.payload };
  }
  return inspected;
}

export async function completeIdempotencyKey(input: {
  client: IdempotencyClient;
  institutionId: string;
  scope: string;
  key: string;
  payload: Record<string, unknown>;
  requestHash?: string;
}) {
  await input.client.idempotencyRecord.update({
    where: {
      institutionId_scope_key: {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
      },
    },
    data: {
      responseJson: input.requestHash
        ? encodeEnvelope({ requestHash: input.requestHash, state: "COMPLETED", payload: input.payload })
        : JSON.stringify(input.payload),
    },
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
