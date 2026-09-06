import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { cleanupUnreferencedStoredFile, readStoredFile, STORAGE_DIR } from "@/lib/storage";

const prefix = "phase38-proof-";
const objectKeys = new Set<string>();

async function createStoredFile(institutionId: string) {
  const id = `${prefix}${crypto.randomUUID()}`;
  const objectKey = `${id}.pdf`;
  const bytes = Buffer.from("%PDF- phase38 proof lifecycle\n", "utf8");

  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(path.join(STORAGE_DIR, objectKey), bytes);
  objectKeys.add(objectKey);

  await db.storedFile.create({
    data: {
      id,
      institutionId,
      objectKey,
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      scanStatus: "CLEAN",
    },
  });

  return { id, objectKey, bytes };
}

async function objectExists(objectKey: string): Promise<boolean> {
  try {
    await stat(path.join(STORAGE_DIR, objectKey));
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

afterAll(async () => {
  await db.payment.deleteMany({ where: { institutionId: { startsWith: prefix } } });
  await db.expense.deleteMany({ where: { institutionId: { startsWith: prefix } } });
  await db.storedFile.deleteMany({ where: { institutionId: { startsWith: prefix } } });
  await Promise.all(
    [...objectKeys].map((objectKey) => unlink(path.join(STORAGE_DIR, objectKey)).catch(() => {}))
  );
  await db.$disconnect();
});

describe("stored proof lifecycle", () => {
  test("removes both metadata and bytes for an unreferenced staged proof", async () => {
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const stored = await createStoredFile(institutionId);

    expect(await objectExists(stored.objectKey)).toBe(true);
    expect(await cleanupUnreferencedStoredFile(stored.id, institutionId)).toBe(true);

    expect(await db.storedFile.findUnique({ where: { id: stored.id } })).toBeNull();
    expect(await objectExists(stored.objectKey)).toBe(false);
  });

  test("never removes evidence while a payment still references it", async () => {
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const stored = await createStoredFile(institutionId);

    const payment = await db.payment.create({
      data: {
        institutionId,
        displayNumber: `PAY-PH38-${crypto.randomUUID()}`,
        residentId: `${prefix}resident-${crypto.randomUUID()}`,
        amountMinor: 12345,
        method: "CASH",
        status: "PENDING",
        proofFileId: stored.id,
      },
    });

    expect(await cleanupUnreferencedStoredFile(stored.id, institutionId)).toBe(false);
    expect(await db.storedFile.findUnique({ where: { id: stored.id } })).not.toBeNull();
    expect(await objectExists(stored.objectKey)).toBe(true);

    await db.payment.delete({ where: { id: payment.id } });
    expect(await cleanupUnreferencedStoredFile(stored.id, institutionId)).toBe(true);
    expect(await objectExists(stored.objectKey)).toBe(false);
  });

  test("removes stale metadata even when the filesystem object is already missing", async () => {
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const stored = await createStoredFile(institutionId);

    await unlink(path.join(STORAGE_DIR, stored.objectKey));
    expect(await cleanupUnreferencedStoredFile(stored.id, institutionId)).toBe(true);
    expect(await db.storedFile.findUnique({ where: { id: stored.id } })).toBeNull();
  });

  test("returns the exact bytes only while runtime proof integrity still matches", async () => {
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const stored = await createStoredFile(institutionId);

    const read = await readStoredFile(stored.id, institutionId);
    expect(read?.buffer.equals(stored.bytes)).toBe(true);
    expect(read?.mimeType).toBe("application/pdf");
  });

  test("fails closed when proof bytes are replaced without changing their length", async () => {
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const stored = await createStoredFile(institutionId);
    const tampered = Buffer.from(stored.bytes);
    tampered[tampered.length - 1] ^= 1;
    expect(tampered.length).toBe(stored.bytes.length);

    await writeFile(path.join(STORAGE_DIR, stored.objectKey), tampered);

    expect(await readStoredFile(stored.id, institutionId)).toBeNull();
  });

  test("fails closed when proof size no longer matches immutable metadata", async () => {
    const institutionId = `${prefix}${crypto.randomUUID()}`;
    const stored = await createStoredFile(institutionId);

    await writeFile(path.join(STORAGE_DIR, stored.objectKey), Buffer.concat([stored.bytes, Buffer.from("x")]));

    expect(await readStoredFile(stored.id, institutionId)).toBeNull();
  });
});
