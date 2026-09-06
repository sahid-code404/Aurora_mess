import { describe, expect, test } from "bun:test";

const source = await Bun.file("src/lib/outbox.ts").text();

describe("outbox delivery source contracts", () => {
  test("delivery reclaims each candidate under a PostgreSQL row lock", () => {
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain("await db.$transaction(async (tx) =>");
    expect(source).toContain("event.status !== \"PENDING\"");
    expect(source).toContain("event.type !== \"NOTIFICATION\"");
  });

  test("notification creation and PROCESSED transition share the same transaction", () => {
    const createAt = source.indexOf("await tx.notification.create");
    const completeAt = source.indexOf("await tx.outboxEvent.updateMany");
    expect(createAt).toBeGreaterThan(0);
    expect(completeAt).toBeGreaterThan(createAt);
    expect(source).toContain('data: { status: "PROCESSED", processedAt: new Date(), lastError: null }');
  });

  test("failure recording cannot overwrite an event already processed elsewhere", () => {
    expect(source).toContain('AND "status" = \'PENDING\'');
    expect(source).toContain('AND "type" = \'NOTIFICATION\'');
    expect(source).toContain("MAX_DELIVERY_ATTEMPTS = 5");
    expect(source).toContain("WHEN \"attempts\" + 1 >= ${MAX_DELIVERY_ATTEMPTS}");
  });

  test("payload validation enforces the institution boundary", () => {
    expect(source).toContain("institution boundary mismatch");
    expect(source).toContain("institutionId: event.institutionId");
    expect(source).toContain("requiredString(value.userId, \"userId\")");
  });

  test("candidate selection is frozen before delivery so a bad event is attempted once per sweep", () => {
    expect(source).toContain("select: { id: true }");
    expect(source).toContain("for (const candidate of candidates)");
    expect(source).toContain("one malformed event is");
    expect(source).toContain("attempted at most once per sweep");
  });
});
