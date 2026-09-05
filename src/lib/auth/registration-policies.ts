import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";

export type RegistrationAcceptance = {
  policyId: string;
  policyVersionId: string;
};

type RegistrationDb = Prisma.TransactionClient | typeof db;

/**
 * Validate the complete current registration policy set.
 *
 * Registration UI is populated from /auth/policies, which returns the latest
 * version of every ACTIVE policy that has a published version. The write path
 * must enforce the same complete set; accepting one arbitrary active policy is
 * not sufficient when several are currently required.
 */
export async function validateCurrentRegistrationAcceptances(
  institutionId: string,
  acceptances: RegistrationAcceptance[],
  client: RegistrationDb = db
): Promise<RegistrationAcceptance[]> {
  const policies = await client.policy.findMany({
    where: { institutionId, status: "ACTIVE" },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });

  const required = policies
    .filter((policy) => policy.versions.length > 0)
    .map((policy) => ({
      policyId: policy.id,
      policyVersionId: policy.versions[0].id,
    }));

  if (required.length === 0) return [];

  const supplied = new Map<string, string>();
  for (const acceptance of acceptances) supplied.set(acceptance.policyId, acceptance.policyVersionId);

  const missingOrStale = required.filter(
    (requirement) => supplied.get(requirement.policyId) !== requirement.policyVersionId
  );
  const requiredIds = new Set(required.map((requirement) => requirement.policyId));
  const unexpected = [...supplied.keys()].filter((policyId) => !requiredIds.has(policyId));

  if (missingOrStale.length > 0 || unexpected.length > 0 || supplied.size !== required.length) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "The community policies changed or were not all accepted. Please review the current policies and try again.",
      400,
      { acceptances: "Accept every current community policy before submitting." }
    );
  }

  return required;
}
