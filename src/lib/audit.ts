/**
 * AUDIT — append-only. Always written in the SAME transaction as the mutation
 * it describes (spec §65). Never updated or deleted by normal runtime.
 */
import { db } from "@/lib/db";

type AuditClient = Parameters<Parameters<typeof db.$transaction>[0]>[0] extends never
  ? typeof db
  : any;

export type AuditInput = {
  institutionId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  reason?: string | null;
  beforeSummary?: string | null;
  afterSummary?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
};

/** Append an audit event. Pass a prisma tx client to keep it atomic with the mutation. */
export async function appendAudit(input: AuditInput, client: any = db): Promise<void> {
  await client.auditEvent.create({
    data: {
      institutionId: input.institutionId,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      requestId: input.requestId ?? null,
      reason: input.reason ?? null,
      beforeSummary: input.beforeSummary ?? null,
      afterSummary: input.afterSummary ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 250) : null,
    },
  });
}
