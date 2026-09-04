/**
 * Admin task submissions review list (spec §146): submitted purchases with
 * items + proofs, resident names, ready for approve/reject. Newest first.
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const status = ctx.req.nextUrl.searchParams.get("status") ?? "SUBMITTED";
  const rows = await db.taskSubmission.findMany({
    where: {
      status,
      task: { institutionId: ctx.institutionId },
    },
    include: {
      items: true,
      task: {
        select: {
          id: true,
          description: true,
          taskType: true,
          dueDate: true,
          status: true,
          assignedResidentId: true,
        },
      },
    },
    orderBy: { submittedAt: "desc" },
    take: 50,
  });

  // Task carries only the resident FK (no relation on Task) — resolve names in one batch.
  const residentIds = [...new Set(rows.map((s) => s.task.assignedResidentId))];
  const residents = await db.user.findMany({
    where: { id: { in: residentIds } },
    select: { id: true, profile: { select: { fullName: true, roomNumber: true } } },
  });
  const residentById = new Map(residents.map((r) => [r.id, r]));

  return {
    data: rows.map((s) => {
      const resident = residentById.get(s.task.assignedResidentId);
      return {
        id: s.id,
        taskId: s.taskId,
        status: s.status,
        comment: s.comment,
        claimedTotalMinor: s.claimedTotalMinor,
        submittedAt: s.submittedAt,
        reviewedAt: s.reviewedAt,
        reviewReason: s.reviewReason,
        expenseId: s.expenseId,
        proofFileId: s.proofFileId,
        resident: {
          id: s.task.assignedResidentId,
          fullName: resident?.profile?.fullName ?? "Resident",
          roomNumber: resident?.profile?.roomNumber ?? null,
        },
        task: {
          description: s.task.description,
          taskType: s.task.taskType,
          dueDate: s.task.dueDate,
          status: s.task.status,
        },
        items: s.items,
      };
    }),
    meta: { count: rows.length },
  };
});
