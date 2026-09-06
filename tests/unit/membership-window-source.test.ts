import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("membership window source guards", () => {
  test("dedicated membership edit follows Institution -> Resident -> reread -> history guard -> update", () => {
    const route = source("src/app/api/v1/admin/residents/[id]/membership/route.ts");
    const transaction = route.indexOf("db.$transaction");
    const institutionLock = route.indexOf(
      "await lockInstitutionFinancialMutation(tx, ctx.institutionId)",
      transaction
    );
    const residentLock = route.indexOf(
      "await lockResidentLifecycleMutation(tx, ctx.institutionId, id)",
      institutionLock
    );
    const reread = route.indexOf("tx.user.findUnique", residentLock);
    const historyGuard = route.indexOf("await assertMembershipWindowPreservesBilledHistory", reread);
    const update = route.indexOf("await tx.user.update", historyGuard);

    expect(transaction).toBeGreaterThan(-1);
    expect(institutionLock).toBeGreaterThan(transaction);
    expect(residentLock).toBeGreaterThan(institutionLock);
    expect(reread).toBeGreaterThan(residentLock);
    expect(historyGuard).toBeGreaterThan(reread);
    expect(update).toBeGreaterThan(historyGuard);
    expect(route).not.toContain("billedStarts.some");
    expect(route).not.toContain("await db.user.findFirst");
  });

  test("generic resident PATCH cannot bypass the shared membership history boundary", () => {
    const whole = source("src/app/api/v1/admin/residents/[id]/route.ts");
    const patchStart = whole.indexOf("export const PATCH");
    const route = whole.slice(patchStart);
    const transaction = route.indexOf("db.$transaction");
    const membershipFlag = route.indexOf("const membershipChanging");
    const institutionLock = route.indexOf(
      "await lockInstitutionFinancialMutation(tx, ctx.institutionId)",
      transaction
    );
    const residentLock = route.indexOf(
      "await lockResidentLifecycleMutation(tx, ctx.institutionId, id)",
      institutionLock
    );
    const reread = route.indexOf("await tx.user.findUnique", residentLock);
    const historyGuard = route.indexOf("await assertMembershipWindowPreservesBilledHistory", reread);
    const update = route.indexOf("await tx.user.update", historyGuard);

    expect(patchStart).toBeGreaterThan(-1);
    expect(membershipFlag).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(membershipFlag);
    expect(institutionLock).toBeGreaterThan(transaction);
    expect(residentLock).toBeGreaterThan(institutionLock);
    expect(reread).toBeGreaterThan(residentLock);
    expect(historyGuard).toBeGreaterThan(reread);
    expect(update).toBeGreaterThan(historyGuard);
    expect(route).not.toContain("billedStarts.some");
    expect(route).not.toContain("await db.user.findFirst");
  });

  test("shared guard checks both start and end boundaries for every BILLED period", () => {
    const guard = source("src/lib/domain/membership-window.ts");

    expect(guard).toContain('where: { institutionId, status: "BILLED" }');
    expect(guard).toContain("before.membershipEffectiveFrom");
    expect(guard).toContain("after.membershipEffectiveFrom");
    expect(guard).toContain('"FROM"');
    expect(guard).toContain("before.membershipEffectiveUntil");
    expect(guard).toContain("after.membershipEffectiveUntil");
    expect(guard).toContain('"UNTIL"');
    expect(guard).toContain("CODES.BILLING_PERIOD_CLOSED");
  });
});
