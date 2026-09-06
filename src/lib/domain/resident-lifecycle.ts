import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type ResidentLifecycleLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type ResidentLifecycleReadClient = Pick<Prisma.TransactionClient, "user">;

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

/**
 * Re-read the authoritative Resident account after its User-row mutex has been
 * acquired by either lockResidentLifecycleMutation() or the equivalent
 * lockResidentFinancialMutation(). This helper intentionally DOES NOT lock by
 * itself: preserving the caller's established Institution -> Resident lock
 * order avoids hidden lock-order cycles.
 */
export async function requireActiveResidentAfterLock(
  client: ResidentLifecycleReadClient,
  institutionId: string,
  residentId: string
) {
  const resident = await client.user.findUnique({
    where: { id: residentId },
    include: { profile: true },
  });

  if (!resident || resident.institutionId !== institutionId || resident.role !== "RESIDENT") {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }
  if (resident.status !== "ACTIVE") {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `This action requires an active resident account (currently ${resident.status.replace(/_/g, " ").toLowerCase()}).`,
      409
    );
  }
  return resident;
}
