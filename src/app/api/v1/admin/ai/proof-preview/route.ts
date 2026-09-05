/**
 * POST /api/v1/admin/ai/proof-preview — VLM-assisted payment proof reading (spec §70 AI assist).
 * Backend-only z-ai-web-dev-sdk vision call. The AI output is a SUGGESTION for the
 * reviewing admin — it never mutates the payment, never auto-approves, and the
 * admin's own decision remains the authoritative action.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { readStoredFile } from "@/lib/storage";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { appendAudit } from "@/lib/audit";
import ZAI from "z-ai-web-dev-sdk";

const bodySchema = z.object({ fileId: z.string().min(1) });

const SYSTEM_PROMPT = `You read payment proof screenshots for a mess finance admin. Extract only what is visible.
Respond with STRICT JSON (no markdown): {"amount": string|null, "method": "UPI"|"CASH"|"BANK_TRANSFER"|"OTHER"|null, "reference": string|null, "payer_or_note": string|null, "summary": string}
- amount: the transferred amount as digits (e.g. "2000.00"), null if absent/unclear
- reference: UTR / transaction id / cheque no if visible
- payer_or_note: any visible payer name or note
- summary: one short sentence describing the proof (e.g. "UPI screenshot showing ₹2,000 sent to Aurora Mess")
If the image is not a payment proof, set fields null and say so in summary.`;

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const rl = await rateLimit(clientKey(ctx.req, "ai-proof-preview"), 12, 5 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(CODES.RATE_LIMITED, "AI preview is busy — try again in a moment.", 429);
  }
  const body = await parseBody(ctx.req, bodySchema);

  // Payment must belong to this institution (and exist) before reading its proof.
  const payment = await db.payment.findFirst({
    where: { institutionId: ctx.institutionId, proofFileId: body.fileId },
  });
  if (!payment) {
    throw new ApiError(CODES.NOT_FOUND, "No payment proof found for this file.", 404);
  }
  const file = await readStoredFile(body.fileId, ctx.institutionId);
  if (!file) {
    throw new ApiError(CODES.NOT_FOUND, "This proof file could not be read.", 404);
  }
  if (!file.mimeType.startsWith("image/")) {
    throw new ApiError(CODES.FILE_INVALID, "AI preview is available for image proofs only.", 400);
  }

  const zai = await ZAI.create();
  const base64 = file.buffer.toString("base64");
  const response = await zai.chat.completions.createVision({
    model: "glm-4.5v",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SYSTEM_PROMPT },
          { type: "image_url", image_url: { url: `data:${file.mimeType};base64,${base64}` } },
        ],
      },
    ],
    thinking: { type: "disabled" },
  });
  const content = response.choices[0]?.message?.content ?? "";

  let parsed: Record<string, unknown> | null = null;
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? (JSON.parse(jsonMatch[0]) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  await appendAudit({
    institutionId: ctx.institutionId,
    actorUserId: ctx.user.id,
    actorRole: "ADMIN",
    action: "AI_PROOF_PREVIEWED",
    entityType: "PAYMENT",
    entityId: payment.id,
    requestId: ctx.requestId,
    afterSummary: JSON.stringify({ fileId: body.fileId, extracted: parsed?.summary ?? null }),
  });

  return {
    data: {
      suggestion: parsed,
      raw: parsed ? null : content.slice(0, 600),
      disclaimer:
        "AI reading is a suggestion to help you review — always verify against the payment details before deciding.",
    },
  };
});
