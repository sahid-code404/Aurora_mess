import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";
import { lockResidentLifecycleMutation } from "@/lib/domain/resident-lifecycle";

export const UNFINISHED_RESIDENT_TASK_STATES = [
  "ASSIGNED",
  "ACCEPTED",
  "IN_PROGRESS",
  "SUBMITTED",
] as const;

type Client = Prisma.TransactionClient;

/**
 * Call while holding the Resident User-row mutex. A resident whose access is
 * about to be removed must not own work that only that resident can progress.
 */
export async function assertNoUnfinishedResidentTasks(
  client: Client,
  institutionId: string,
  residentId: string
): Promise<void> {
  const count = await client.task.count({
    where: {
      institutionId,
      assignedResidentId: residentId,
      status: { in: [...UNFINISHED_RESIDENT_TASK_STATES] },
    },
  });
  if (count > 0) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Resolve or reassign ${count} unfinished task${count === 1 ? "" : "s"} before removing this resident's access.`,
      409
    );
  }
}

/**
 * Task assignment is a Resident lifecycle-sensitive mutation. Lock first, then
 * re-read ACTIVE state so deactivation/deletion and assignment cannot validate
 * against different snapshots of the same Resident.
 */
export async function lockActiveResidentForTaskAssignment(
  client: Client,
  institutionId: string,
  residentId: string
) {
  await lockResidentLifecycleMutation(client, institutionId, residentId);
  const resident = await client.user.findUnique({
    where: { id: residentId },
    include: { profile: true },
  });
  if (!resident || resident.status !== "ACTIVE") {
    throw new ApiError(CODES.VALIDATION_FAILED, "Pick an active resident for this task.", 400, {
      assignedResidentId: "Pick an active resident.",
    });
  }
  return resident;
}
