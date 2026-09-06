import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";

afterAll(async () => {
  await db.$disconnect();
});

describe("finite policy exemption database contract", () => {
  test("PostgreSQL requires every policy exemption to have an expiry", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PolicyExemption' AND column_name = 'expiresAt'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("NO");
  });
});
