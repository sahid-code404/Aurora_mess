import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { appendOutbox } from "@/lib/outbox";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";
import { addDaysToKey, dateKeyInTz, zonedTimeToUtc } from "@/lib/time";

const POLICY_TYPE = "DEFICIT_RESTRICTION";
type Client = any;

type ActorInput = {
  institutionId: string;
  residentId: string;
  actorUserId: string;
  requestId: string;
  now?: Date;
};

async function inTransaction<T>(client: Client, fn: (tx: Client) => Promise<T>): Promise<T> {
  if (typeof client?.$transaction === "function") return client.$transaction(fn);
  return fn(client);
}

/**
 * Convert a local expiry date into the final millisecond of that institution
 * calendar day. Using next-local-midnight minus 1ms keeps DST/offset changes
 * correct instead of pretending the institution runs on UTC.
 */
export function policyExemptionExpiryAt(dateKey: string, timeZone: string): Date {
  const nextKey = addDaysToKey(dateKey, 1);
  const [year, month, day] = nextKey.split("-").map(Number);
  const nextMidnight = zonedTimeToUtc(year, month, day, 0, 0, timeZone);
  return new Date(nextMidnight.getTime() - 1);
}

function isActiveWhere(now: Date) {
  return {
    policyType: POLICY_TYPE,
    startsAt: { lte: now },
    expiresAt: { gt: now },
  };
}

export async function grantDeficitPolicyExemption(
  input: ActorInput & { reason: string; expiresOn: string },
  client: Client = db
) {
  const now = input.now ?? new Date();
  return inTransaction(client, async (tx) => {
    // The Resident row is shared with status/deletion/financial lifecycle work,
    // so an exemption cannot be granted against stale ACTIVE state.
    await lockResidentLifecycleMutation(tx, input.institutionId, input.residentId);

    const [resident, institution] = await Promise.all([
      tx.user.findUnique({ where: { id: input.residentId } }),
      tx.institution.findUnique({ where: { id: input.institutionId }, select: { timezone: true } }),
    ]);
    if (!resident || resident.role !== "RESIDENT" || resident.institutionId !== input.institutionId) {
      throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
    }
    if (resident.status !== "ACTIVE") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Deficit exemptions can only be granted to active residents (currently ${resident.status
          .replace(/_/g, " ")
          .toLowerCase()}).`,
        409
      );
    }
    if (!institution) throw new ApiError(CODES.NOT_FOUND, "Institution not found.", 404);

    const todayKey = dateKeyInTz(now, institution.timezone);
    if (input.expiresOn < todayKey) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
        expiresAt: "Expiry must be today or a future date in the institution timezone.",
      });
    }

    const existing = await tx.policyExemption.findFirst({
      where: {
        institutionId: input.institutionId,
        residentId: resident.id,
        ...isActiveWhere(now),
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "This resident already has an active deficit-policy exemption. Cancel it or let it expire before creating another.",
        409
      );
    }

    const expiresAt = policyExemptionExpiryAt(input.expiresOn, institution.timezone);
    const created = await tx.policyExemption.create({
      data: {
        institutionId: input.institutionId,
        residentId: resident.id,
        policyType: POLICY_TYPE,
        reason: input.reason,
        startsAt: now,
        expiresAt,
        approvedByUserId: input.actorUserId,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "POLICY_EXEMPTION_CREATED",
        entityType: "POLICY_EXEMPTION",
        entityId: created.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: "—",
        afterSummary: `until ${created.expiresAt.toISOString()}`,
        metadata: {
          residentId: resident.id,
          expiresOn: input.expiresOn,
          expiresAt: created.expiresAt.toISOString(),
          timeZone: institution.timezone,
        },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: resident.id,
        institutionId: input.institutionId,
        type: "POLICY_EXEMPTION",
        title: "Meal restriction exemption granted",
        message: `You've been granted a temporary exemption from deficit meal restrictions through ${input.expiresOn}.`,
        entityRef: created.id,
      },
      tx
    );

    return created;
  });
}

export async function cancelDeficitPolicyExemption(
  input: Omit<ActorInput, "residentId"> & { exemptionId: string; reason: string },
  client: Client = db
) {
  const now = input.now ?? new Date();

  // The first read only discovers the immutable resident mutex key. All
  // authoritative validation happens again after the User row is locked.
  const discovered = await client.policyExemption.findFirst({
    where: { id: input.exemptionId, institutionId: input.institutionId, policyType: POLICY_TYPE },
    select: { residentId: true },
  });
  if (!discovered) throw new ApiError(CODES.NOT_FOUND, "Exemption not found.", 404);

  return inTransaction(client, async (tx) => {
    await lockResidentLifecycleMutation(tx, input.institutionId, discovered.residentId);

    const exemption = await tx.policyExemption.findFirst({
      where: { id: input.exemptionId, institutionId: input.institutionId, policyType: POLICY_TYPE },
    });
    if (!exemption) throw new ApiError(CODES.NOT_FOUND, "Exemption not found.", 404);

    const isActive =
      exemption.startsAt.getTime() <= now.getTime() &&
      exemption.expiresAt.getTime() > now.getTime();
    if (!isActive) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "This exemption has already expired or been cancelled.",
        409
      );
    }

    const updated = await tx.policyExemption.update({
      where: { id: exemption.id },
      data: { expiresAt: now },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.actorUserId,
        actorRole: "ADMIN",
        action: "POLICY_EXEMPTION_CANCELLED",
        entityType: "POLICY_EXEMPTION",
        entityId: exemption.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: `until ${exemption.expiresAt.toISOString()}`,
        afterSummary: `ended ${now.toISOString()}`,
        metadata: { residentId: exemption.residentId },
      },
      tx
    );

    await appendOutbox(
      input.institutionId,
      "NOTIFICATION",
      {
        userId: exemption.residentId,
        institutionId: input.institutionId,
        type: "POLICY_EXEMPTION_CANCELLED",
        title: "Meal restriction exemption ended",
        message: `Your deficit-policy exemption has ended. Reason: ${input.reason}`,
        entityRef: exemption.id,
      },
      tx
    );

    return updated;
  });
}
