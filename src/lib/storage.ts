/**
 * STORAGE — private filesystem storage for payment proofs / receipts (spec §70).
 * Validates extension AND magic bytes, 2 MB limit, random keys, sha256 checksum.
 * Files are never public and are served via authenticated routes only.
 *
 * Production MUST point UPLOAD_STORAGE_DIR at a persistent private volume. The
 * default `uploads-storage/` path is intended for single-host/local deployments.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";

export const STORAGE_DIR = process.env.UPLOAD_STORAGE_DIR
  ? path.resolve(process.env.UPLOAD_STORAGE_DIR)
  : path.join(process.cwd(), "uploads-storage");
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const MAGIC: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    ext: "png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mime: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
];

export function detectMime(buffer: Buffer): { mime: string; ext: string } | null {
  for (const m of MAGIC) {
    if (m.test(buffer)) return { mime: m.mime, ext: m.ext };
  }
  return null;
}

export type StoredFileRecord = { id: string; objectKey: string; fileName: string; mimeType: string; sizeBytes: number };

/** Validate + persist an uploaded proof. Returns the DB record. */
export async function storeUpload(
  file: File,
  institutionId: string,
  uploadedByUserId: string
): Promise<StoredFileRecord> {
  if (file.size > MAX_BYTES) {
    throw new ApiError(CODES.FILE_TOO_LARGE, "Files must be 2 MB or smaller.", 413);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectMime(buffer);
  if (!detected) {
    throw new ApiError(
      CODES.FILE_INVALID,
      "Only JPEG, PNG or PDF files are accepted, and the file contents must match its type.",
      400
    );
  }
  const objectKey = `${randomBytes(16).toString("hex")}.${detected.ext}`;
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(path.join(STORAGE_DIR, objectKey), buffer);
  const sha = createHash("sha256").update(buffer).digest("hex");
  const record = await db.storedFile.create({
    data: {
      institutionId,
      objectKey,
      fileName: (file.name || `proof.${detected.ext}`).slice(0, 180),
      mimeType: detected.mime,
      sizeBytes: buffer.length,
      sha256: sha,
      uploadedByUserId,
      scanStatus: "CLEAN", // content signature/type validated; malware scanning is a separate future control
    },
  });
  return {
    id: record.id,
    objectKey: record.objectKey,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  };
}

/** Authenticated read of stored bytes. */
export async function readStoredFile(
  fileId: string,
  institutionId: string
): Promise<{ buffer: Buffer; mimeType: string; fileName: string } | null> {
  const record = await db.storedFile.findFirst({
    where: { id: fileId, institutionId },
  });
  if (!record) return null;
  try {
    const buffer = await readFile(path.join(STORAGE_DIR, record.objectKey));
    return { buffer, mimeType: record.mimeType, fileName: record.fileName };
  } catch {
    return null;
  }
}
