/**
 * GET /api/v1/files/[id] — authenticated download of a stored proof file.
 * Authorization: ADMIN of the institution, the uploader, or a RESIDENT whose
 * own payment / task-submission proof references the file. Everyone else
 * (including unknown ids) gets a plain 404 — existence is never leaked.
 * Returns raw bytes with the stored content type; files are NEVER listed.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { readStoredFile } from "@/lib/storage";

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const fileId = ctx.params.id;

  const file = await db.storedFile.findFirst({
    where: { id: fileId, institutionId: ctx.institutionId },
  });
  if (!file) {
    throw new ApiError(CODES.NOT_FOUND, "File not found.", 404);
  }

  let allowed = ctx.user.role === "ADMIN";
  if (!allowed && file.uploadedByUserId) {
    allowed = file.uploadedByUserId === ctx.user.id;
  }
  if (!allowed && ctx.user.role === "RESIDENT") {
    const [ownPayment, ownSubmission] = await Promise.all([
      db.payment.findFirst({
        where: { proofFileId: fileId, residentId: ctx.user.id },
        select: { id: true },
      }),
      db.taskSubmission.findFirst({
        where: { proofFileId: fileId, task: { assignedResidentId: ctx.user.id } },
        select: { id: true },
      }),
    ]);
    allowed = Boolean(ownPayment ?? ownSubmission);
  }
  if (!allowed) {
    throw new ApiError(CODES.NOT_FOUND, "File not found.", 404);
  }

  const stored = await readStoredFile(fileId, ctx.institutionId);
  if (!stored) {
    throw new ApiError(CODES.NOT_FOUND, "File not found.", 404);
  }

  // Filename is metadata from upload — keep it inert in the header.
  const safeName = stored.fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";

  return new NextResponse(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      "Content-Type": stored.mimeType,
      "Content-Length": String(stored.buffer.length),
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
