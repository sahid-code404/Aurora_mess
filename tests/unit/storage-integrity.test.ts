import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveSafeObjectPath,
  verifyStoredFileIntegrity,
  verifyStorageIntegrityRecords,
} from "@/lib/storage-integrity";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "boardops-storage-integrity-"));
  tempDirs.push(dir);
  return dir;
}

function record(id: string, objectKey: string, bytes: Buffer) {
  return {
    id,
    objectKey,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("private upload integrity", () => {
  test("accepts a matching regular file", async () => {
    const dir = await tempDir();
    const bytes = Buffer.from("proof-bytes");
    await writeFile(path.join(dir, "proof.bin"), bytes);

    expect(await verifyStoredFileIntegrity(dir, record("file-1", "proof.bin", bytes))).toBeNull();
  });

  test("rejects traversal and nested object keys", async () => {
    const dir = await tempDir();
    expect(resolveSafeObjectPath(dir, "../outside.bin")).toBeNull();
    expect(resolveSafeObjectPath(dir, "nested/proof.bin")).toBeNull();
    expect(resolveSafeObjectPath(dir, "proof.bin")).toBe(path.join(dir, "proof.bin"));
  });

  test("reports missing, size-mismatched and checksum-mismatched files", async () => {
    const dir = await tempDir();
    const expected = Buffer.from("expected-proof");

    const missing = await verifyStoredFileIntegrity(dir, record("missing", "missing.bin", expected));
    expect(missing?.type).toBe("MISSING_FILE");

    await writeFile(path.join(dir, "wrong-size.bin"), Buffer.from("x"));
    const wrongSize = await verifyStoredFileIntegrity(
      dir,
      record("wrong-size", "wrong-size.bin", expected)
    );
    expect(wrongSize?.type).toBe("SIZE_MISMATCH");

    const sameLengthDifferentBytes = Buffer.from("different-proof");
    expect(sameLengthDifferentBytes.length).toBe(expected.length);
    await writeFile(path.join(dir, "wrong-sha.bin"), sameLengthDifferentBytes);
    const wrongSha = await verifyStoredFileIntegrity(dir, record("wrong-sha", "wrong-sha.bin", expected));
    expect(wrongSha?.type).toBe("CHECKSUM_MISMATCH");
  });

  test("rejects symlinks instead of following bytes outside the storage root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const bytes = Buffer.from("external-proof");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(outside, "outside.bin"), bytes);
    await symlink(path.join(outside, "outside.bin"), path.join(root, "linked.bin"));

    const issue = await verifyStoredFileIntegrity(root, record("linked", "linked.bin", bytes));
    expect(issue?.type).toBe("NOT_REGULAR_FILE");
  });

  test("aggregates issues without treating unrelated orphan files as failures", async () => {
    const dir = await tempDir();
    const bytes = Buffer.from("authoritative");
    await writeFile(path.join(dir, "authoritative.bin"), bytes);
    await writeFile(path.join(dir, "orphan.bin"), Buffer.from("harmless orphan"));

    const report = await verifyStorageIntegrityRecords(dir, [
      record("good", "authoritative.bin", bytes),
      record("bad", "missing.bin", bytes),
    ]);
    expect(report.checked).toBe(2);
    expect(report.issues).toEqual([{ id: "bad", type: "MISSING_FILE" }]);
  });
});
