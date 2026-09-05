import type { Prisma } from "@prisma/client";

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
}): Promise<ClaimResult> {
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

  const existing = await input.client.idempotencyRecord.findUnique({
    where: {
      institutionId_scope_key: {
        institutionId: input.institutionId,
        scope: input.scope,
        key: input.key,
      },
    },
  });

  if (existing?.responseJson) {
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
