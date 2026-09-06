import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("admin read-model integrity", () => {
  test("Refund History sends its visible search to the refund API and renders refund errors", () => {
    const payments = source("src/components/app/admin/payments.tsx");
    const refundRoute = source("src/app/api/v1/admin/refunds/route.ts");

    expect(payments).toContain(
      '{ q: status === "REFUNDS" ? appliedSearch || undefined : undefined }'
    );
    expect(payments).toContain("refundsQuery.error ? (");
    expect(payments).toContain('title={appliedSearch ? "No refunds match" : "No refunds recorded"}');
    expect(payments).toContain(
      'q: status === "REFUNDS" || status === "REFUND_CENTER" ? undefined : appliedSearch || undefined'
    );

    expect(refundRoute).toContain('const q = (url.searchParams.get("q") ?? "").trim();');
    expect(refundRoute).toContain('{ profile: { fullName: { contains: q } } }');
    expect(refundRoute).toContain('{ profile: { roomNumber: { contains: q } } }');
    expect(refundRoute).toContain('{ reason: { contains: q } }');
    expect(refundRoute).toContain('{ destination: { contains: q } }');
  });

  test("Payments current-month reset follows the institution timezone", () => {
    const payments = source("src/components/app/admin/payments.tsx");
    expect(payments).toContain('import { currentMonthKeyInTz } from "./_shared/business-date";');
    expect(payments).toContain("const thisMonthKey = currentMonthKeyInTz(tz);");
    expect(payments).not.toContain("const thisMonthKey = todayKey().slice(0, 7)");
  });

  test("dashboard API and client agree on non-null institution copy and nullable audit references", () => {
    const route = source("src/app/api/v1/admin/dashboard/route.ts");
    const dashboard = source("src/components/app/admin/dashboard.tsx");

    expect(route).toContain('institutionName: inst?.name ?? "Institution"');
    expect(dashboard).toContain("entityId: string | null;");
    expect(dashboard).toContain("actorRole: string | null;");
    expect(dashboard).toContain("sub: mealChargeSub,");
  });

  test("dashboard action rows are keyboard buttons with reduced-motion-aware tactile feedback", () => {
    const dashboard = source("src/components/app/admin/dashboard.tsx");

    expect(dashboard).toContain('import { motion, useReducedMotion } from "framer-motion";');
    expect(dashboard).toContain("const rowMotion = reducedMotion");
    expect(dashboard.match(/<motion\.button/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(dashboard).toContain('type="button"');
    expect(dashboard).toContain("focus-visible:outline-2");
  });
});
