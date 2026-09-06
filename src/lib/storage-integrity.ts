import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export type StoredFileIntegrityRecord = {
  id: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
};

export type StorageIntegrityIssue = {
  id: string;
  type:
    | "UNSAFE_OBJECT_KEY"
    | "MISSING_FILE"
    | "NOT_REGULAR_FILE"
    | "SIZE_MISMATCH"
    | "CHECKSUM_MISMATCH";
};

export type StorageIntegrityReport = {
  checked: number;
  issues: StorageIntegrityIssue[];
};

type IntegrityCandidate =
  | { filePath: string; issue: null }
  | { filePath: null; issue: StorageIntegrityIssue };

/** Resolve a DB object key without permitting traversal or nested paths. */
export function resolveSafeObjectPath(storageDir: string, objectKey: string): string | null {
  if (!objectKey || objectKey.includes("\0")) return null;
  if (path.basename(objectKey) !== objectKey || objectKey === "." || objectKey === "..") return null;

  const root = path.resolve(storageDir);
  const candidate = path.resolve(root, objectKey);
  if (path.dirname(candidate) !== root) return null;
  return candidate;
}

async function resolveIntegrityCandidate(
  storageDir: string,
  record: StoredFileIntegrityRecord
): Promise<IntegrityCandidate> {
  const filePath = resolveSafeObjectPath(storageDir, record.objectKey);
  if (!filePath) {
    return { filePath: null, issue: { id: record.id, type: "UNSAFE_OBJECT_KEY" } };
  }

  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { filePath: null, issue: { id: record.id, type: "MISSING_FILE" } };
    }
    throw error;
  }

  if (!info.isFile() || info.isSymbolicLink()) {
    return { filePath: null, issue: { id: record.id, type: "NOT_REGULAR_FILE" } };
  }
  if (info.size !== record.sizeBytes) {
    return { filePath: null, issue: { id: record.id, type: "SIZE_MISMATCH" } };
  }

  return { filePath, issue: null };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * Verify authoritative StoredFile metadata against private filesystem bytes.
 * Symlinks are rejected: a DB-backed proof must be a regular file directly
 * inside the configured storage root.
 */
export async function verifyStoredFileIntegrity(
  storageDir: string,
  record: StoredFileIntegrityRecord
): Promise<StorageIntegrityIssue | null> {
  const candidate = await resolveIntegrityCandidate(storageDir, record);
  if (candidate.issue) return candidate.issue;

  const actualSha256 = await sha256File(candidate.filePath);
  if (actualSha256.toLowerCase() !== record.sha256.toLowerCase()) {
    return { id: record.id, type: "CHECKSUM_MISMATCH" };
  }

  return null;
}

/**
 * Read proof bytes through the same integrity boundary used by backup checks.
 * The checksum is calculated from the exact Buffer returned to the caller, so
 * a runtime download/AI preview never trusts an unchecked second filesystem
 * read after validation.
 */
export async function readVerifiedStoredFileBytes(
  storageDir: string,
  record: StoredFileIntegrityRecord
): Promise<{ buffer: Buffer | null; issue: StorageIntegrityIssue | null }> {
  const candidate = await resolveIntegrityCandidate(storageDir, record);
  if (candidate.issue) return { buffer: null, issue: candidate.issue };

  let buffer: Buffer;
  try {
    buffer = await readFile(candidate.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { buffer: null, issue: { id: record.id, type: "MISSING_FILE" } };
    }
    throw error;
  }

  // Re-check size from the exact bytes read. This catches a file changing
  // between lstat() and readFile() rather than serving a partially replaced
  // object after its pre-read metadata happened to match.
  if (buffer.length !== record.sizeBytes) {
    return { buffer: null, issue: { id: record.id, type: "SIZE_MISMATCH" } };
  }

  const actualSha256 = createHash("sha256").update(buffer).digest("hex");
  if (actualSha256.toLowerCase() !== record.sha256.toLowerCase()) {
    return { buffer: null, issue: { id: record.id, type: "CHECKSUM_MISMATCH" } };
  }

  return { buffer, issue: null };
}

export async function verifyStorageIntegrityRecords(
  storageDir: string,
  records: StoredFileIntegrityRecord[]
): Promise<StorageIntegrityReport> {
  const issues: StorageIntegrityIssue[] = [];
  for (const record of records) {
    const issue = await verifyStoredFileIntegrity(storageDir, record);
    if (issue) issues.push(issue);
  }
  return { checked: records.length, issues };
}
