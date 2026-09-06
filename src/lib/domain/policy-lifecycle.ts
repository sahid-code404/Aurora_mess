import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type Client = Prisma.TransactionClient;

/** Serialize mutations of one versioned policy so publish/archive/reactivate
 * decisions always use the authoritative status and version history. */
export async function lockPolicyMutation(client: Client, institutionId: string, policyId: string) {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Policy"
    WHERE "id" = ${policyId}
      AND "institutionId" = ${institutionId}
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new ApiError(CODES.NOT_FOUND, "This policy could not be found.", 404);
  }
  const policy = await client.policy.findUnique({
    where: { id: policyId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!policy || policy.institutionId !== institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "This policy could not be found.", 404);
  }
  return policy;
}
