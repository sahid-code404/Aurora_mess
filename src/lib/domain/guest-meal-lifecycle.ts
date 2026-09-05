import { db } from "@/lib/db";
import { lockInstitutionResidentFinancialMutations } from "@/lib/domain/financial-lock";

export type GuestMealLifecycleStatus = "REQUESTED" | "CONFIRMED" | "LOCKED" | "CANCELLED" | "CONSUMED";

export function deriveGuestMealLifecycleStatus(
  status: string,
  cutoffAt: Date,
  serviceEndAt: Date,
  now = new Date()
): GuestMealLifecycleStatus {
  if (status === "CANCELLED" || status === "CONSUMED" || status === "REQUESTED") {
    return status as GuestMealLifecycleStatus;
  }
  if (now.getTime() >= serviceEndAt.getTime()) return "CONSUMED";
  if (status === "CONFIRMED" && now.getTime() >= cutoffAt.getTime()) return "LOCKED";
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
 * Billing calls this function first during its interactive transaction, without
 * a hostResidentId. In that exact transaction-scoped form we also acquire every
 * resident financial mutex before any lifecycle/readiness query. This turns the
 * existing billing lifecycle boundary into a coherent financial snapshot
 * boundary without making ordinary guest-history GET refreshes hold locks.
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

  // Prisma interactive transaction clients intentionally do not expose
  // `$transaction`. Billing passes one explicitly and has no host scope. The
  // global db client (ordinary GET refreshes) keeps its normal non-locking path.
  const isInteractiveTransaction = Boolean(options.client) && typeof options.client.$transaction !== "function";
  if (isInteractiveTransaction && !options.hostResidentId) {
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
      mealInstance: { select: { cutoffAt: true, serviceEndAt: true } },
    },
  });

  let locked = 0;
  let consumed = 0;
  for (const row of rows) {
    const next = deriveGuestMealLifecycleStatus(
      row.status,
      row.mealInstance.cutoffAt,
      row.mealInstance.serviceEndAt,
      now
    );
    if (next === row.status) continue;

    const updated = await client.guestMealRequest.updateMany({
      where: { id: row.id, status: row.status },
      data:
        next === "LOCKED"
          ? { status: "LOCKED", lockedAt: row.lockedAt ?? row.mealInstance.cutoffAt }
          : { status: "CONSUMED", lockedAt: row.lockedAt ?? row.mealInstance.cutoffAt },
    });
    if (updated.count !== 1) continue;
    if (next === "LOCKED") locked += 1;
    if (next === "CONSUMED") consumed += 1;
  }

  return { locked, consumed };
}
