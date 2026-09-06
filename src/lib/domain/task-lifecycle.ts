import { Prisma } from "@prisma/client";
import { ApiError, CODES } from "@/lib/errors";

type TaskLifecycleLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Serialize state transitions for one task.
 *
 * Task actions are intentionally split across Resident and Admin routes. A
 * read-then-write status check without a row mutex lets concurrent requests
 * both validate the same old state and then overwrite one another. The Task
 * row is the stable lifecycle mutex, so every mutable task transition must
 * acquire it before re-reading and validating status.
 *
 * LOCK ORDER: when a mutation also needs the institution financial mutex, take
 * Institution first and Task second. Resident-only pre-submission transitions
 * need only the Task mutex.
 */
export async function lockTaskLifecycleMutation(
  client: TaskLifecycleLockClient,
  institutionId: string,
  taskId: string
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Task"
    WHERE "id" = ${taskId}
      AND "institutionId" = ${institutionId}
    FOR UPDATE
  `);

  if (rows.length !== 1) {
    throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
  }
}
