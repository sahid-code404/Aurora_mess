/**
 * POST /api/v1/tasks/[id]/submission — resident submits completed task work.
 *
 * MARKET_PURCHASE:
 *   multipart/form-data with itemsJson + optional comment/proof. Item totals are
 *   always recomputed server-side and later become an official Expense only
 *   after Admin approval.
 *
 * GENERAL:
 *   multipart/form-data with optional comment/proof and NO purchase items.
 *   The submission carries claimedTotalMinor=0 and can be Admin-approved without
 *   creating any Expense or journal.
 *
 * Both task kinds share the same authoritative lifecycle:
 * ASSIGNED → ACCEPTED → IN_PROGRESS → SUBMITTED → APPROVED/REJECTED_BY_ADMIN.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { multiplyRoundHalfUp, parseDecimalToMinor } from "@/lib/money";
import { cleanupUnreferencedStoredFile, storeUpload } from "@/lib/storage";
import { appendAudit } from "@/lib/audit";
import { requireInstitutionContext } from "@/lib/domain/meal-engine";
import { notifyAdmins, resolveNotificationsForEntity, sweepOutboxSafe } from "@/lib/domain/notify";

const itemSchema = z.object({
  itemName: z.string().trim().min(1, "Item name is required.").max(120),
  quantity: z.coerce.number().positive("Quantity must be positive.").max(1_000_000),
  unit: z.string().trim().max(20).optional(),
  unitPrice: z.string().min(1, "Unit price is required."),
});

const itemsSchema = z.array(itemSchema).min(1, "Add at least one item.").max(50);

type SubmissionLine = {
  itemName: string;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  lineTotalMinor: number;
};

function parseMarketLines(itemsJsonRaw: FormDataEntryValue | null): SubmissionLine[] {
  if (typeof itemsJsonRaw !== "string" || itemsJsonRaw.trim() === "") {
    throw new ApiError(CODES.VALIDATION_FAILED, "The item list is required for a market task.", 400, {
      itemsJson: "Add at least one purchased item.",
    });
  }

  let parsedItemsJson: unknown;
  try {
    parsedItemsJson = JSON.parse(itemsJsonRaw);
  } catch {
    throw new ApiError(CODES.VALIDATION_FAILED, "The item list could not be read as JSON.", 400, {
      itemsJson: "The item list could not be read as JSON.",
    });
  }

  const parsedItems = itemsSchema.safeParse(parsedItemsJson);
  if (!parsedItems.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsedItems.error.issues) {
      const key = `items.${issue.path.join(".")}`;
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the item list.", 400, fields);
  }

  const lines: SubmissionLine[] = [];
  for (const [idx, item] of parsedItems.data.entries()) {
    const unitPriceMinor = parseDecimalToMinor(item.unitPrice);
    if (unitPriceMinor == null || unitPriceMinor <= 0) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Please check the item list.", 400, {
        [`items.${idx}.unitPrice`]: "Enter a valid price like 55.00.",
      });
    }
    lines.push({
      itemName: item.itemName,
      quantity: item.quantity,
      unit: item.unit && item.unit !== "" ? item.unit : "unit",
      unitPriceMinor,
      lineTotalMinor: multiplyRoundHalfUp(item.quantity, unitPriceMinor),
    });
  }
  return lines;
}

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  await requireInstitutionContext(ctx.institutionId);

  let form: FormData;
  try {
    form = await ctx.req.formData();
  } catch {
    throw new ApiError(CODES.VALIDATION_FAILED, "The request must be submitted as a form.", 400);
  }

  const commentRaw = form.get("comment");
  const comment =
    typeof commentRaw === "string" && commentRaw.trim() !== "" ? commentRaw.trim().slice(0, 500) : null;

  // Read the task before interpreting the payload: Normal Tasks intentionally
  // do not accept purchase lines while Market Tasks require them.
  const preflightTask = await db.task.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    select: { id: true, taskType: true, status: true },
  });
  if (!preflightTask) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
  if (preflightTask.status !== "IN_PROGRESS") {
    throw new ApiError(
      CODES.TASK_INVALID_STATE,
      preflightTask.status === "ACCEPTED"
        ? "Start the task before submitting your work."
        : "This task is not in a state that accepts a submission.",
      409
    );
  }

  const isMarketTask = preflightTask.taskType === "MARKET_PURCHASE";
  const itemsJsonRaw = form.get("itemsJson");
  if (!isMarketTask && typeof itemsJsonRaw === "string" && itemsJsonRaw.trim() !== "") {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "Normal task completion does not accept purchase items or prices.",
      400,
      { itemsJson: "Remove purchase items from this Normal Task completion." }
    );
  }

  const lines = isMarketTask ? parseMarketLines(itemsJsonRaw) : [];
  const claimedTotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

  // Optional proof (validated: magic bytes + ≤2MB) — useful as a receipt for
  // Market Tasks or completion evidence for Normal Tasks. Storage lives outside
  // PostgreSQL, so an aborted submission explicitly removes this staged proof.
  const proofRaw = form.get("proof");
  let proofFileId: string | null = null;
  if (proofRaw instanceof File && proofRaw.size > 0) {
    const stored = await storeUpload(proofRaw, ctx.institutionId, ctx.user.id);
    proofFileId = stored.id;
  }

  const result = await (async () => {
    try {
      return await db.$transaction(async (tx) => {
        const task = await tx.task.findFirst({
          where: { id: ctx.params.id, institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
        });
        if (!task) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
        if (task.status !== "IN_PROGRESS") {
          throw new ApiError(CODES.TASK_INVALID_STATE, "This task is not in a state that accepts a submission.", 409);
        }
        if (task.taskType !== preflightTask.taskType) {
          throw new ApiError(CODES.RESOURCE_CHANGED, "This task changed while you were submitting it. Please reload.", 409);
        }

        const existing = await tx.taskSubmission.findUnique({ where: { taskId: task.id } });
        if (existing) {
          throw new ApiError(CODES.TASK_INVALID_STATE, "This task already has a submission.", 409);
        }

        const submission = await tx.taskSubmission.create({
          data: {
            taskId: task.id,
            comment,
            claimedTotalMinor,
            status: "SUBMITTED",
            proofFileId,
          },
        });
        for (const line of lines) {
          await tx.taskSubmissionItem.create({
            data: { taskSubmissionId: submission.id, ...line },
          });
        }
        const updatedTask = await tx.task.update({
          where: { id: task.id },
          data: { status: "SUBMITTED" },
        });

        const isGeneralTask = task.taskType === "GENERAL";
        await appendAudit(
          {
            institutionId: ctx.institutionId,
            actorUserId: ctx.user.id,
            actorRole: "RESIDENT",
            action: isGeneralTask ? "TASK_COMPLETION_SUBMITTED" : "TASK_SUBMITTED",
            entityType: "TASK",
            entityId: task.id,
            requestId: ctx.requestId,
            beforeSummary: JSON.stringify({ status: task.status }),
            afterSummary: JSON.stringify({
              status: "SUBMITTED",
              submissionId: submission.id,
              claimedTotalMinor,
              taskType: task.taskType,
            }),
            metadata: {
              description: task.description,
              taskType: task.taskType,
              itemCount: lines.length,
              claimedTotalMinor,
              hasProof: proofFileId != null,
              hasComment: comment != null,
            },
          },
          tx
        );

        await notifyAdmins(
          ctx.institutionId,
          {
            type: "TASK_SUBMITTED",
            title: isGeneralTask ? "Normal task ready for verification" : "Market task purchase ready for verification",
            message: isGeneralTask
              ? `Completion for "${task.description}" is waiting for your verification.`
              : `Purchase submission for "${task.description}" is waiting for your verification.`,
            entityRef: task.id,
          },
          tx
        );

        await resolveNotificationsForEntity({
          institutionId: ctx.institutionId,
          entityRef: task.id,
          types: ["TASK_ASSIGNED"],
          actorUserId: ctx.user.id,
          actorRole: "RESIDENT",
          reason: isGeneralTask ? "Normal task completion submitted by resident" : "Market task purchase submitted by resident",
          client: tx,
        });

        return { submission, updatedTask, taskType: task.taskType };
      });
    } catch (error) {
      if (proofFileId) {
        await cleanupUnreferencedStoredFile(proofFileId, ctx.institutionId).catch(() => false);
      }
      throw error;
    }
  })();

  await sweepOutboxSafe();
  return {
    data: {
      id: result.submission.id,
      taskId: result.submission.taskId,
      taskType: result.taskType,
      status: result.submission.status,
      comment: result.submission.comment,
      claimedTotalMinor: result.submission.claimedTotalMinor,
      proofFileId: result.submission.proofFileId,
      submittedAt: result.submission.submittedAt.toISOString(),
      items: lines,
      taskStatus: result.updatedTask.status,
    },
  };
});