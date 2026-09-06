import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function ordered(route: string, needles: string[]) {
  let cursor = -1;
  for (const needle of needles) {
    const next = route.indexOf(needle, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("resident self-service serialization source contracts", () => {
  test("shared ACTIVE assertion is a post-lock authoritative read, not a hidden lock", () => {
    const domain = source("src/lib/domain/resident-lifecycle.ts");
    const helper = domain.indexOf("export async function requireActiveResidentAfterLock");
    expect(helper).toBeGreaterThan(-1);
    const body = domain.slice(helper);
    expect(body).toContain("await client.user.findUnique");
    expect(body).toContain('resident.status !== "ACTIVE"');
    expect(body).not.toContain("$queryRaw");
  });

  test("resident guest quantity adjustment locks ACTIVE account before authoritative guest read and qualified write", () => {
    const route = source("src/app/api/v1/guest-meals/[id]/route.ts");
    ordered(route, [
      "db.$transaction",
      "await lockActiveResidentForMealMutation",
      "await tx.guestMealRequest.findFirst",
      "guest.mealInstance.lockAt",
      "await tx.guestMealRequest.updateMany",
      "await appendAudit",
    ]);
    expect(route).not.toContain("const guest = await db.guestMealRequest.findFirst");
    expect(route).not.toContain("tx.guestMealRequest.update({");
    expect(route).toContain("status: guest.status");
    expect(route).toContain("quantity: guest.quantity");
  });

  test("payment submission locks financial mutex and revalidates ACTIVE before idempotency claim/create", () => {
    const route = source("src/app/api/v1/payments/route.ts");
    const post = route.indexOf('export const POST = route({ auth: "RESIDENT" }');
    const tx = route.indexOf("db.$transaction", post);
    const lock = route.indexOf("await lockResidentFinancialMutation", tx);
    const active = route.indexOf("await requireActiveResidentAfterLock", lock);
    const create = route.indexOf("await tx.payment.create", active);
    expect(tx).toBeGreaterThan(post);
    expect(lock).toBeGreaterThan(tx);
    expect(active).toBeGreaterThan(lock);
    expect(create).toBeGreaterThan(active);
  });

  test("payment withdrawal moves ownership/state read behind financial mutex and ACTIVE assertion", () => {
    const route = source("src/app/api/v1/payments/[id]/cancel/route.ts");
    ordered(route, [
      "db.$transaction",
      "await lockResidentFinancialMutation",
      "await requireActiveResidentAfterLock",
      "await tx.payment.findFirst",
      "await tx.payment.updateMany",
      "await tx.paymentStatusHistory.create",
      "await appendAudit",
    ]);
    expect(route).not.toContain("const payment = await db.payment.findFirst");
  });

  test("persisted leave submission locks/revalidates ACTIVE before transactional meal-scope validation and create", () => {
    const route = source("src/app/api/v1/leave-requests/route.ts");
    const preview = route.indexOf("if (previewRequested)");
    const tx = route.indexOf("db.$transaction", preview);
    ordered(route.slice(tx), [
      "db.$transaction",
      "await lockResidentLifecycleMutation",
      "await requireActiveResidentAfterLock",
      "await validateMealScopeSelection",
      "await tx.leaveRequest.create",
      "await appendAudit",
    ]);
  });

  test("resident leave cancellation re-reads PENDING leave only after Resident ACTIVE lock", () => {
    const route = source("src/app/api/v1/leave-requests/[id]/cancel/route.ts");
    ordered(route, [
      "db.$transaction",
      "await lockResidentLifecycleMutation",
      "await requireActiveResidentAfterLock",
      "await tx.leaveRequest.findFirst",
      "await tx.leaveRequest.updateMany",
      "await appendAudit",
    ]);
    expect(route).not.toContain("const leave = await db.leaveRequest.findFirst");
  });

  test("admin leave approval uses only immutable resident ownership before the mutex and re-reads lifecycle after it", () => {
    const route = source("src/app/api/v1/admin/leave-requests/[id]/approve/route.ts");
    ordered(route, [
      "const target = await db.leaveRequest.findFirst",
      "db.$transaction",
      "await lockResidentLifecycleMutation",
      "await requireActiveResidentAfterLock",
      "await tx.leaveRequest.findFirst",
      "await tx.leaveRequest.updateMany",
    ]);
    const targetStart = route.indexOf("const target = await db.leaveRequest.findFirst");
    const txStart = route.indexOf("db.$transaction", targetStart);
    expect(route.slice(targetStart, txStart)).toContain("select: { residentId: true }");
    expect(route.slice(targetStart, txStart)).not.toContain("status:");
  });
});
