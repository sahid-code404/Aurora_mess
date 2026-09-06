import { db } from "@/lib/db";
import { lockInstitutionResidentFinancialMutations } from "@/lib/domain/financial-lock";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";

export type GuestMealLifecycleStatus = "REQUESTED" | "CONFIRMED" | "LOCKED" | "CANCELLED" | "CONSUMED";

export function deriveGuestMealLifecycleStatus(
  status: string,
  lockAt: Date,
  serviceEndAt: Date,
  now = new Date()
): GuestMealLifecycleStatus {
  if (status === "CANCELLED" || status === "CONSUMED" || status === "REQUESTED") {
    return status as GuestMealLifecycleStatus;
  }
  if (now.getTime() >= serviceEndAt.getTime()) return "CONSUMED";
  if (status === "CONFIRMED" && now.getTime() >= lockAt.getTime()) return "LOCKED";
  return status as GuestMealLifecycleStatus;
}

/**
 * Persist time-derived guest-meal lifecycle transitions.
 *
 * CONFIRMED -> LOCKED at cutoff
 * CONFIRMED/LOCKED -> CONSUMED after service ends
 * CANCELLED and legacy REQUESTED rows are never auto-promoted.
 *
 * Status-qualified updateMany calls make concurrent refreshes idempotent.
 *
 * Billing calls this function first during its transaction, without a
 * hostResidentId and with an explicit transaction client. In that exact
 * transaction-scoped form we acquire the institution billing mutex first and
 * then every resident settlement mutex before any lifecycle/readiness query.
 * This is the global financial lock order: Institution -> resident User rows.
 * Ordinary guest-history refreshes use the global client (or a host scope) and
 * therefore do not hold transaction-wide billing locks.
 */
export async function refreshGuestMealLifecycle(options: {
  institutionId: string;
  hostResidentId?: string;
  from?: Date;
  to?: Date;
  now?: Date;
  client?: any;
}): Promise<{ locked: number; consumed: number }> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  // An explicitly supplied client with no host scope is the billing-readiness
  // contract. In an actual Prisma transaction these FOR UPDATE locks persist to
  // commit; with the global client they are harmless statement-scoped guards.
  if (options.client && !options.hostResidentId) {
    await lockInstitutionFinancialMutation(client, options.institutionId);
    await lockInstitutionResidentFinancialMutations(client, options.institutionId);
  }

  const rows = await client.guestMealRequest.findMany({
    where: {
      institutionId: options.institutionId,
      ...(options.hostResidentId ? { hostResidentId: options.hostResidentId } : {}),
      status: { in: ["CONFIRMED", "LOCKED"] },
      ...((options.from || options.to)
        ? {
            mealInstance: {
              serviceDate: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            },
          }
        : {}),
    },
    include: {
      mealInstance: { select: { lockAt: true, serviceEndAt: true } },
    },
  });

  let locked = 0;
  let consumed = 0;
  for (const row of rows) {
    const next = deriveGuestMealLifecycleStatus(
      row.status,
      row.mealInstance.lockAt,
      row.mealInstance.serviceEndAt,
      now
    );
    if (next === row.status) continue;

    const updated = await client.guestMealRequest.updateMany({
      where: { id: row.id, status: row.status },
      data:
        next === "LOCKED"
          ? { status: "LOCKED", lockedAt: row.lockedAt ?? row.mealInstance.lockAt }
          : { status: "CONSUMED", lockedAt: row.lockedAt ?? row.mealInstance.lockAt },
    });
    if (updated.count !== 1) continue;
    if (next === "LOCKED") locked += 1;
    if (next === "CONSUMED") consumed += 1;
  }

  return { locked, consumed };
}
