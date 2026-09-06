import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

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
  const resident = await client.user.findUnique({
    where: { id: residentId },
    include: { profile: true },
  });
  if (!resident || resident.institutionId !== institutionId || resident.role !== "RESIDENT") {
    throw new ApiError(CODES.NOT_FOUND, "This resident could not be found.", 404);
  }
  if (resident.status !== "ACTIVE") {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `This meal change requires an active resident account (currently ${resident.status.replace(/_/g, " ").toLowerCase()}).`,
      409
    );
  }
  return resident;
}
