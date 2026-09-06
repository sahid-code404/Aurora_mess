import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { appendAudit } from "@/lib/audit";
import { reasonSchema } from "@/lib/validation";
import { ApiError, CODES } from "@/lib/errors";
import { lockPolicyMutation } from "@/lib/domain/policy-lifecycle";

const bodySchema = z.object({ reason: reasonSchema });

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, bodySchema);
  const result = await db.$transaction(async (tx) => {
    const policy = await lockPolicyMutation(tx, ctx.institutionId, ctx.params.id);
    if (policy.status !== "ACTIVE") {
      throw new ApiError(CODES.RESOURCE_CHANGED, "This policy is already archived.", 409);
    }

    const updated = await tx.policy.update({
      where: { id: policy.id },
      data: { status: "ARCHIVED" },
    });

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "POLICY_ARCHIVED",
        entityType: "POLICY",
        entityId: policy.id,
        requestId: ctx.requestId,
        reason: body.reason,
        beforeSummary: JSON.stringify({ status: policy.status, latestVersion: policy.versions[0]?.version ?? null }),
        afterSummary: JSON.stringify({ status: "ARCHIVED", latestVersion: policy.versions[0]?.version ?? null }),
      },
      tx
    );

    return updated;
  });

  return { data: { id: result.id, status: result.status } };
});
