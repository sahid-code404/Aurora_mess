/**
 * /api/v1/admin/policies — versioned policy management (spec §67-68).
 * GET  → all policies of the institution with every published version
 *        (newest first) and the latest version highlighted.
 * POST → publish { type, title, content }: creates a new ACTIVE Policy with
 *        version 1, or appends the next immutable PolicyVersion to an
 *        existing policy. Existing publish/archive/reactivate mutations share
 *        the Policy row mutex. Publishing an archived policy deliberately
 *        reactivates it with a new immutable version.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { appendAudit } from "@/lib/audit";
import { lockPolicyMutation } from "@/lib/domain/policy-lifecycle";

const policyPublishSchema = z.object({
  type: z.enum(["TERMS_OF_SERVICE", "PRIVACY", "HOUSE_RULES", "MEAL_POLICY"]),
  title: z.string().trim().min(2, "Give the policy a title.").max(120),
  content: z
    .string()
    .trim()
    .min(10, "Policy content is too short.")
    .max(100000, "Policy content is too long."),
});

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const policies = await db.policy.findMany({
    where: { institutionId: ctx.institutionId },
    include: { versions: { orderBy: { version: "desc" } } },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });

  return {
    data: policies.map((policy) => ({
      id: policy.id,
      type: policy.type,
      title: policy.title,
      status: policy.status,
      content: policy.content,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
      latestVersion: policy.versions[0]
        ? {
            id: policy.versions[0].id,
            version: policy.versions[0].version,
            publishedAt: policy.versions[0].publishedAt,
          }
        : null,
      versions: policy.versions.map((v) => ({
        id: v.id,
        version: v.version,
        publishedAt: v.publishedAt,
        content: v.content,
      })),
    })),
  };
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, policyPublishSchema);

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.policy.findUnique({
      where: {
        institutionId_type_title: {
          institutionId: ctx.institutionId,
          type: body.type,
          title: body.title,
        },
      },
      select: { id: true },
    });

    if (existing) {
      const policy = await lockPolicyMutation(tx, ctx.institutionId, existing.id);
      const latest = policy.versions[0] ?? null;
      const nextVersion = (latest?.version ?? 0) + 1;
      const version = await tx.policyVersion.create({
        data: { policyId: policy.id, version: nextVersion, content: body.content },
      });
      await tx.policy.update({
        where: { id: policy.id },
        data: { content: body.content, status: "ACTIVE" },
      });
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: ctx.user.id,
          actorRole: "ADMIN",
          action: "POLICY_PUBLISHED",
          entityType: "POLICY",
          entityId: policy.id,
          requestId: ctx.requestId,
          beforeSummary: JSON.stringify({ status: policy.status, version: latest?.version ?? null }),
          afterSummary: JSON.stringify({ type: body.type, title: body.title, status: "ACTIVE", version: nextVersion }),
          metadata: { reactivatedByPublish: policy.status === "ARCHIVED" },
          ip: ctx.req.headers.get("x-forwarded-for") ?? null,
          userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
        },
        tx
      );
      return { policyId: policy.id, policyVersionId: version.id, version: nextVersion, created: false };
    }

    const policy = await tx.policy.create({
      data: {
        institutionId: ctx.institutionId,
        type: body.type,
        title: body.title,
        content: body.content,
        status: "ACTIVE",
      },
    });
    const version = await tx.policyVersion.create({
      data: { policyId: policy.id, version: 1, content: body.content },
    });
    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "POLICY_PUBLISHED",
        entityType: "POLICY",
        entityId: policy.id,
        requestId: ctx.requestId,
        afterSummary: JSON.stringify({ type: body.type, title: body.title, status: "ACTIVE", version: 1 }),
        ip: ctx.req.headers.get("x-forwarded-for") ?? null,
        userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
      },
      tx
    );
    return { policyId: policy.id, policyVersionId: version.id, version: 1, created: true };
  });

  return { data: result };
});
