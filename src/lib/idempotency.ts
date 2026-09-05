import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type IdempotencyClient = Pick<Prisma.TransactionClient, "idempotencyRecord">;

type ClaimResult =
  | { state: "CLAIMED" }
  | { state: "REPLAY"; payload: Record<string, unknown> }
  | { state: "IN_PROGRESS" };

export async function claimIdempotencyKey(input: {
  client: IdempotencyClient;
  institutionId: string;
  scope: string;
  key: string;
  expiresAt: Date;
  now?: Date;
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
    return {
      state: "REPLAY",
      payload: JSON.parse(existing.responseJson) as Record<string, unknown>,
    };
  }

  return { state: "IN_PROGRESS" };
}

export async function completeIdempotencyKey(input: {
  client: IdempotencyClient;
  institutionId: string;
  scope: string;
  key: string;
  payload: Record<string, unknown>;
}) {
  await input.client.idempotencyRecord.update({
    where: {
      institutionId_scope_key: {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
      },
    },
    data: { responseJson: JSON.stringify(input.payload) },
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
