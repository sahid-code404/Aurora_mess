import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";

const prefix = "phase64-billing-state-";
const institutionIds: string[] = [];

afterAll(async () => {
  if (institutionIds.length > 0) {
    await db.billingPeriod.deleteMany({ where: { institutionId: { in: institutionIds } } });
    await db.institution.deleteMany({ where: { id: { in: institutionIds } } });
  }
  await db.$disconnect();
});

describe("billing generation database contract", () => {
  test("generationError was removed and canonical committed states are representable", async () => {
    const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BillingPeriod' AND column_name = 'generationError'`
    );
    expect(cols).toHaveLength(0);

    const institution = await db.institution.create({
      data: {
        name: `${prefix}${crypto.randomUUID()}`,
        timezone: "UTC",
      },
    });
    institutionIds.push(institution.id);

    const closedAt = new Date("2031-02-28T23:59:59.000Z");
    const billedAt = new Date("2031-03-01T00:00:00.000Z");

    await db.billingPeriod.createMany({
      data: [
        {
          institutionId: institution.id,
          year: 2031,
          month: 1,
          status: "OPEN",
          generationState: null,
        },
        {
          institutionId: institution.id,
          year: 2031,
          month: 2,
          status: "BILLED",
          generationState: "COMPLETED",
          closedAt,
          billedAt,
        },
        {
          institutionId: institution.id,
          year: 2031,
          month: 3,
          status: "REOPENED",
          generationState: null,
        },
      ],
    });

    const rows = await db.billingPeriod.findMany({
      where: { institutionId: institution.id },
      orderBy: { month: "asc" },
      select: { status: true, generationState: true },
    });

    expect(rows).toEqual([
      { status: "OPEN", generationState: null },
      { status: "BILLED", generationState: "COMPLETED" },
      { status: "REOPENED", generationState: null },
    ]);
  });
});
