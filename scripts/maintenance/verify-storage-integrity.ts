import path from "node:path";
import { db } from "@/lib/db";
import { verifyStorageIntegrityRecords } from "@/lib/storage-integrity";

const storageDir = process.env.UPLOAD_STORAGE_DIR
  ? path.resolve(process.env.UPLOAD_STORAGE_DIR)
  : path.join(process.cwd(), "uploads-storage");

const PAGE_SIZE = 250;
let cursor: string | undefined;
let checked = 0;
const issues: { id: string; type: string }[] = [];

try {
  while (true) {
    const rows = await db.storedFile.findMany({
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, objectKey: true, sizeBytes: true, sha256: true },
    });
    if (rows.length === 0) break;

    const report = await verifyStorageIntegrityRecords(storageDir, rows);
    checked += report.checked;
    issues.push(...report.issues);
    cursor = rows[rows.length - 1]?.id;
    if (rows.length < PAGE_SIZE) break;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    service: "boardops",
    event: "storage_integrity_check",
    storageDir,
    checked,
    issueCount: issues.length,
    issues: issues.slice(0, 20),
    truncatedIssues: Math.max(0, issues.length - 20),
  };

  if (issues.length > 0) {
    console.error(JSON.stringify(summary));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(summary));
  }
} finally {
  await db.$disconnect();
}
