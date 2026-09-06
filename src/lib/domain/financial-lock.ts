import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type FinancialLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

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
 * row order. Billing uses this as a transaction-wide financial boundary before
 * it evaluates readiness or reads payment/refund credit.
 *
 * ORDER BY is part of the correctness contract: two billing transactions that
 * ever overlap the same institution must request resident locks in the same
 * order, avoiding lock-order deadlocks. New writes that reference an existing
 * resident are also held behind these FOR UPDATE locks by PostgreSQL's FK row
 * locking until the billing transaction commits.
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
