/**
 * POST /api/v1/tasks/[id]/submission — resident submits purchase results
 * (spec §61). multipart/form-data: comment?, proof? (File ≤2MB), itemsJson =
 * JSON string of [{itemName, quantity, unit, unitPrice}].
 * Line totals are ALWAYS server-computed (multiplyRoundHalfUp) — the client's
 * numbers are never trusted. Idempotent by (task → submission) unique: a
 * second submission gets TASK_INVALID_STATE.
 */
import { z } from "zod";
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { multiplyRoundHalfUp, parseDecimalToMinor } from "@/lib/money";
import { storeUpload } from "@/lib/storage";
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

  const itemsJsonRaw = form.get("itemsJson");
  if (typeof itemsJsonRaw !== "string" || itemsJsonRaw.trim() === "") {
    throw new ApiError(CODES.VALIDATION_FAILED, "The item list is required.", 400, {
      itemsJson: "The item list is required.",
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

  // Money: server parses every decimal string (Int paise only).
  const lines: {
    itemName: string;
    quantity: number;
    unit: string;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }[] = [];
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
  const claimedTotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);

  // Optional proof (validated: magic bytes + ≤2MB) — stored before the tx;
  // a tx failure can orphan a harmless StoredFile row (documented).
  const proofRaw = form.get("proof");
  let proofFileId: string | null = null;
  if (proofRaw instanceof File && proofRaw.size > 0) {
    const stored = await storeUpload(proofRaw, ctx.institutionId, ctx.user.id);
    proofFileId = stored.id;
  }

  const result = await db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({
      where: { id: ctx.params.id, institutionId: ctx.institutionId, assignedResidentId: ctx.user.id },
    });
    if (!task) throw new ApiError(CODES.NOT_FOUND, "This task could not be found.", 404);
    // Spec §61 state machine: work must be STARTED before it can be submitted
    // (ASSIGNED → ACCEPTED → IN_PROGRESS → SUBMITTED). Submission directly from
    // ACCEPTED skips the start step (audit 9-b #4).
    if (task.status !== "IN_PROGRESS") {
      throw new ApiError(
        CODES.TASK_INVALID_STATE,
        task.status === "ACCEPTED"
          ? "Start the task before submitting your work."
          : "This task is not in a state that accepts a submission.",
        409
      );
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

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "TASK_SUBMITTED",
        entityType: "TASK",
        entityId: task.id,
        requestId: ctx.requestId,
        beforeSummary: JSON.stringify({ status: task.status }),
        afterSummary: JSON.stringify({ status: "SUBMITTED", submissionId: submission.id, claimedTotalMinor }),
        metadata: {
          description: task.description,
          itemCount: lines.length,
          claimedTotalMinor,
          hasProof: proofFileId != null,
        },
      },
      tx
    );

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "TASK_SUBMITTED",
        title: "Task submission waiting for verification",
        message: `Submission for "${task.description}" is waiting for your verification.`,
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
      reason: "Task duty proof submitted by resident",
      client: tx,
    });

    return { submission, updatedTask };
  });

  await sweepOutboxSafe();
  return {
    data: {
      id: result.submission.id,
      taskId: result.submission.taskId,
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
