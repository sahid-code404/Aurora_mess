import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";

afterAll(async () => {
  await db.$disconnect();
});

describe("billing generation database contract", () => {
  test("generationError was removed and committed period rows use canonical states", async () => {
    const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BillingPeriod' AND column_name = 'generationError'`
    );
    expect(cols).toHaveLength(0);

    const invalid = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "BillingPeriod" WHERE "status" NOT IN ('OPEN','BILLED','REOPENED') OR ("status" = 'OPEN' AND "generationState" IS NOT NULL) OR ("status" = 'BILLED' AND "generationState" IS DISTINCT FROM 'COMPLETED') OR ("status" = 'REOPENED' AND "generationState" IS NOT NULL)`
    );
    expect(Number(invalid[0]?.count ?? 0n)).toBe(0);
  });
});
