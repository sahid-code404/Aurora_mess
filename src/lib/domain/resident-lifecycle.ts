import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type ResidentLifecycleLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Serialize lifecycle mutations for one resident on the authoritative User row.
 *
 * This is deliberately the same physical mutex used by resident-level financial
 * settlement locks. A lifecycle decision therefore cannot race billing/payment
 * work that is already holding the resident User row, and competing lifecycle
 * decisions observe each other's committed state under PostgreSQL READ COMMITTED.
 *
 * Lock-order rule: callers may take an Institution lock before this row, but
 * must never acquire an Institution lock after this resident row.
 */
export async function lockResidentLifecycleMutation(
  client: ResidentLifecycleLockClient,
  institutionId: string,
  residentId: string
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${residentId}
      AND "institutionId" = ${institutionId}
      AND "role" = 'RESIDENT'
    FOR UPDATE
  `);

  if (rows.length !== 1) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }
}
