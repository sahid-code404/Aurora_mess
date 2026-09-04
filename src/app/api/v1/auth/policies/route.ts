/**
 * GET /api/v1/auth/policies — PUBLIC. Active policies with their latest
 * published versions, used by the registration acceptance checkboxes.
 * Returns [] when the institution or policies do not exist yet (never 500).
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { getInstitution } from "@/lib/institution";

export const GET = route({ auth: "PUBLIC" }, async () => {
  const institution = await getInstitution();
  if (!institution) return { data: [] };

  const policies = await db.policy.findMany({
    where: { institutionId: institution.id, status: "ACTIVE" },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });

  const data = policies
    .filter((policy) => policy.versions.length > 0)
    .map((policy) => ({
      policyId: policy.id,
      policyVersionId: policy.versions[0].id,
      type: policy.type,
      title: policy.title,
      content: policy.versions[0].content,
      version: policy.versions[0].version,
    }));

  return { data };
});
