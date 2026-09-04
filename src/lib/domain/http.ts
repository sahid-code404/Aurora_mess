/**
 * HTTP HELPERS (domain) — multipart form extraction, opaque cursor codec and
 * keyset-cursor where-clause building shared by the finance list endpoints.
 */
import type { NextRequest } from "next/server";
import { ApiError, CODES } from "@/lib/errors";

/** Parse a multipart/form-data body with a friendly error. */
export async function readFormData(req: NextRequest): Promise<FormData> {
  try {
    const form = await req.formData();
    if (!form) throw new Error("empty");
    return form;
  } catch {
    throw new ApiError(CODES.VALIDATION_FAILED, "The request must be sent as multipart form data.", 400);
  }
}

/** Trimmed text field value (undefined when absent/blank). */
export function formText(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A real uploaded file for a field (null when absent or an empty text entry). */
export function formFile(form: FormData, key: string): File | null {
  const value = form.get(key);
  if (value instanceof File && value.size > 0) return value;
  return null;
}

/** Parse a JSON string field with a friendly error. */
export function parseJsonField<T>(raw: string | undefined, field: string): T {
  if (!raw) throw new ApiError(CODES.VALIDATION_FAILED, `The ${field} field must be valid JSON.`, 400, { [field]: `The ${field} field must be valid JSON.` });
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(CODES.VALIDATION_FAILED, `The ${field} field must be valid JSON.`, 400, { [field]: `The ${field} field must be valid JSON.` });
  }
}

/** Opaque base64url cursor. */
export function encodeCursor(payload: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Keyset pagination: base conditions AND (sort column < cursor value, or equal
 * with tie-break id < cursor id). Pass `extra` for additional AND conditions.
 */
export function keysetWhere(
  base: Record<string, unknown>,
  sortField: string,
  cursor: string | undefined,
  limit: number
): { where: Record<string, unknown>; take: number } {
  const where: Record<string, unknown> = { ...base };
  const conditions: Record<string, unknown>[] = [];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    const cursorT = typeof decoded?.t === "string" ? decoded.t : null;
    const cursorId = typeof decoded?.id === "string" ? decoded.id : null;
    if (cursorT && cursorId) {
      conditions.push({
        OR: [
          { [sortField]: { lt: new Date(cursorT) } },
          { [sortField]: new Date(cursorT), id: { lt: cursorId } },
        ],
      });
    }
  }
  if (conditions.length > 0) where.AND = conditions;
  return { where, take: limit + 1 }; // one extra row detects "hasMore"
}

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

/** Slice the over-fetched page and derive the next cursor. */
export function finishPage<T extends { id: string } & Record<string, any>>(
  rows: T[],
  limit: number,
  cursorValue: (row: T) => Date
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ t: cursorValue(last).toISOString(), id: last.id }) : null;
  return { items, nextCursor };
}
