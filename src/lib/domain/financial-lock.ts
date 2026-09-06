import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type FinancialLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Serialize institution-wide mutations that can change billing readiness or an
 * immutable billing snapshot (expenses, submitted task work, bill generation).
 *
 * GLOBAL LOCK ORDER: Institution -> resident User row(s) -> individual Bill.
 * Billing takes the Institution row first and then the resident barrier. Other
 * institution-wide financial mutations must therefore never acquire a resident
 * mutex before this lock, preventing lock-order cycles.
 */
export async function lockInstitutionFinancialMutation(
  client: FinancialLockClient,
  institutionId: string
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Institution"
    WHERE "id" = ${institutionId}
    FOR UPDATE
  `);

  if (rows.length !== 1) {
    throw new ApiError(CODES.NOT_FOUND, "Institution not found.", 404);
  }
}

/**
 * Serialize every resident-level mutation that can change FIFO bill settlement.
 *
 * The User row is the stable mutex because a resident can own many bills and
 * payments. Every settlement-changing path must take this lock BEFORE changing
 * payment status or locking an individual bill. The waiter then observes all
 * previously committed financial transitions under PostgreSQL READ COMMITTED.
 */
export async function lockResidentFinancialMutation(
  client: FinancialLockClient,
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
 * Acquire every resident financial mutex for one institution in deterministic
 * row order. Billing uses this as a transaction-wide resident settlement
 * boundary after taking the Institution mutex.
 *
 * ORDER BY is part of the correctness contract: overlapping billing work asks
 * for resident locks in the same order, avoiding lock-order deadlocks.
 */
export async function lockInstitutionResidentFinancialMutations(
  client: FinancialLockClient,
  institutionId: string
): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "institutionId" = ${institutionId}
      AND "role" = 'RESIDENT'
    ORDER BY "id" ASC
    FOR UPDATE
  `);

  return rows.map((row) => row.id);
}
