import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const TRANSITION_ROUTES = [
  "src/app/api/v1/admin/residents/[id]/approve/route.ts",
  "src/app/api/v1/admin/residents/[id]/reject/route.ts",
  "src/app/api/v1/admin/residents/[id]/request-changes/route.ts",
  "src/app/api/v1/admin/residents/[id]/deactivate/route.ts",
  "src/app/api/v1/admin/residents/[id]/activate/route.ts",
];

describe("resident lifecycle source guards", () => {
  test("every admin status transition locks and re-reads authoritative state inside its transaction", () => {
    for (const path of TRANSITION_ROUTES) {
      const route = source(path);
      const transaction = route.indexOf("db.$transaction");
      const lock = route.indexOf(
        "await lockResidentLifecycleMutation(tx, ctx.institutionId, id)",
        transaction
      );
      const reread = route.indexOf("await tx.user.findUnique", lock);
      const statusUpdate = route.indexOf("await tx.user.update", reread);

      expect(transaction, path).toBeGreaterThan(-1);
      expect(lock, path).toBeGreaterThan(transaction);
      expect(reread, path).toBeGreaterThan(lock);
      expect(statusUpdate, path).toBeGreaterThan(reread);
      expect(route, path).not.toContain("await db.user.findFirst");
    }
  });

  test("approval derives membership start only from the locked resident snapshot", () => {
    const approval = source("src/app/api/v1/admin/residents/[id]/approve/route.ts");
    const lock = approval.indexOf("await lockResidentLifecycleMutation");
    const reread = approval.indexOf("await tx.user.findUnique", lock);
    const now = approval.indexOf("const now = new Date()", reread);
    const effectiveFrom = approval.indexOf("const effectiveFrom = user.membershipEffectiveFrom ?? now", now);

    expect(lock).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(lock);
    expect(now).toBeGreaterThan(reread);
    expect(effectiveFrom).toBeGreaterThan(now);
  });

  test("resident lifecycle and financial settlement intentionally lock the same User row", () => {
    const lifecycle = source("src/lib/domain/resident-lifecycle.ts");
    const financial = source("src/lib/domain/financial-lock.ts");

    for (const implementation of [lifecycle, financial]) {
      expect(implementation).toContain('FROM "User"');
      expect(implementation).toContain('AND "institutionId" = ${institutionId}');
      expect(implementation).toContain("AND \"role\" = 'RESIDENT'");
      expect(implementation).toContain("FOR UPDATE");
    }
  });

  test("session revocation follows a committed serialized rejection/deactivation", () => {
    for (const path of [
      "src/app/api/v1/admin/residents/[id]/reject/route.ts",
      "src/app/api/v1/admin/residents/[id]/deactivate/route.ts",
    ]) {
      const route = source(path);
      const transaction = route.indexOf("await db.$transaction");
      const revoke = route.indexOf("await revokeAllUserSessions(id)");
      expect(transaction, path).toBeGreaterThan(-1);
      expect(revoke, path).toBeGreaterThan(transaction);
    }
  });
});
