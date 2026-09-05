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
