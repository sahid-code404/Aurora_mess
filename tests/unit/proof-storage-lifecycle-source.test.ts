import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("proof storage lifecycle source guards", () => {
  test("storage removes bytes when metadata persistence fails and checks every proof-bearing domain before cleanup", () => {
    const storage = source("src/lib/storage.ts");

    const bytesWritten = storage.indexOf("await writeFile(objectPath, buffer)");
    const metadataCreate = storage.indexOf("record = await db.storedFile.create");
    const metadataFailureCleanup = storage.indexOf("await unlink(objectPath).catch(() => {})");
    const cleanupExport = storage.indexOf("export async function cleanupUnreferencedStoredFile");
    const paymentReference = storage.indexOf("db.payment.findFirst", cleanupExport);
    const expenseReference = storage.indexOf("db.expense.findFirst", cleanupExport);
    const taskReference = storage.indexOf("db.taskSubmission.findFirst", cleanupExport);
    const objectDelete = storage.indexOf("await unlink(path.join(STORAGE_DIR, record.objectKey))", cleanupExport);
    const rowDelete = storage.indexOf("await db.storedFile.deleteMany", cleanupExport);

    expect(bytesWritten).toBeGreaterThan(-1);
    expect(metadataCreate).toBeGreaterThan(bytesWritten);
    expect(metadataFailureCleanup).toBeGreaterThan(metadataCreate);
    expect(cleanupExport).toBeGreaterThan(-1);
    expect(paymentReference).toBeGreaterThan(cleanupExport);
    expect(expenseReference).toBeGreaterThan(cleanupExport);
    expect(taskReference).toBeGreaterThan(cleanupExport);
    expect(objectDelete).toBeGreaterThan(taskReference);
    expect(rowDelete).toBeGreaterThan(objectDelete);
  });

  test("runtime proof reads go through immutable size/checksum verification", () => {
    const storage = source("src/lib/storage.ts");
    const integrity = source("src/lib/storage-integrity.ts");
    const readExport = storage.indexOf("export async function readStoredFile");
    const verifiedRead = storage.indexOf(
      "await readVerifiedStoredFileBytes(STORAGE_DIR, record)",
      readExport
    );
    const rawRead = storage.indexOf("readFile(path.join(STORAGE_DIR, record.objectKey))", readExport);

    expect(readExport).toBeGreaterThan(-1);
    expect(verifiedRead).toBeGreaterThan(readExport);
    expect(rawRead).toBe(-1);
    expect(integrity).toContain("export async function readVerifiedStoredFileBytes");
    expect(integrity).toContain("buffer.length !== record.sizeBytes");
    expect(integrity).toContain('createHash("sha256").update(buffer).digest("hex")');
  });

  test("payment cleans staged proof on rollback and on a late idempotent replay", () => {
    const payment = source("src/app/api/v1/payments/route.ts");
    const staged = payment.indexOf("const proofFile = proof ? await storeUpload");
    const transaction = payment.indexOf("return await db.$transaction", staged);
    const catchCleanup = payment.indexOf("await cleanupUnreferencedStoredFile(proofFile.id, ctx.institutionId)", transaction);
    const replayCleanupGuard = payment.indexOf("if (result.replay && proofFile)", catchCleanup);
    const replayCleanup = payment.indexOf("await cleanupUnreferencedStoredFile(proofFile.id, ctx.institutionId)", replayCleanupGuard);

    expect(staged).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(staged);
    expect(catchCleanup).toBeGreaterThan(transaction);
    expect(replayCleanupGuard).toBeGreaterThan(catchCleanup);
    expect(replayCleanup).toBeGreaterThan(replayCleanupGuard);
  });

  test("expense rejects a closed period before staging proof and cleans transaction failures", () => {
    const expense = source("src/app/api/v1/admin/expenses/route.ts");
    const closedGuard = expense.indexOf("CODES.BILLING_PERIOD_CLOSED");
    const staged = expense.indexOf("const proofFile = proof ? await storeUpload");
    const transaction = expense.indexOf("return await db.$transaction", staged);
    const cleanup = expense.indexOf("await cleanupUnreferencedStoredFile(proofFile.id, ctx.institutionId)", transaction);

    expect(closedGuard).toBeGreaterThan(-1);
    expect(staged).toBeGreaterThan(closedGuard);
    expect(transaction).toBeGreaterThan(staged);
    expect(cleanup).toBeGreaterThan(transaction);
  });

  test("task submission cleans a staged proof if its authoritative transaction rejects", () => {
    const task = source("src/app/api/v1/tasks/[id]/submission/route.ts");
    const staged = task.indexOf("const stored = await storeUpload");
    const transaction = task.indexOf("return await db.$transaction", staged);
    const cleanup = task.indexOf("await cleanupUnreferencedStoredFile(proofFileId, ctx.institutionId)", transaction);

    expect(staged).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(staged);
    expect(cleanup).toBeGreaterThan(transaction);
  });
});
