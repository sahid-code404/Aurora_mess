import { Prisma } from "@prisma/client";
import {
  lockResidentLifecycleMutation,
  requireActiveResidentAfterLock,
} from "@/lib/domain/resident-lifecycle";

type Client = Prisma.TransactionClient;

/**
 * Serialize a meal/guest-meal mutation against Resident access lifecycle work.
 * The authoritative ACTIVE read happens only after the User row mutex is held,
 * so a deactivation/deletion and a billable meal mutation cannot both validate
 * against stale snapshots.
 */
export async function lockActiveResidentForMealMutation(
  client: Client,
  institutionId: string,
  residentId: string
) {
  await lockResidentLifecycleMutation(client, institutionId, residentId);
  return requireActiveResidentAfterLock(client, institutionId, residentId);
}
