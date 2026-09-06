import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { sweepOutbox } from "@/lib/outbox";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function fixture() {
  const institution = await db.institution.create({ data: { name: unique("Outbox Mess"), timezone: "UTC" } });
  const resident = await db.user.create({
    data: {
      institutionId: institution.id,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("outbox-resident")}@example.test`,
      passwordHash: "integration-test-only",
    },
  });
  return { institution, resident };
}

function notificationPayload(institutionId: string, residentId: string, entityRef: string) {
  return {
    userId: residentId,
    institutionId,
    type: "OUTBOX_INTEGRITY_TEST",
    title: "Outbox integrity",
    message: "Exactly one notification must be delivered.",
    entityRef,
  };
}

afterAll(async () => {
  await db.$disconnect();
});

describe("outbox notification delivery integrity", () => {
  test("concurrent sweepers deliver one PENDING event exactly once", async () => {
    const { institution, resident } = await fixture();
    const entityRef = unique("outbox-entity");
    const event = await db.outboxEvent.create({
      data: {
        institutionId: institution.id,
        type: "NOTIFICATION",
        payloadJson: JSON.stringify(notificationPayload(institution.id, resident.id, entityRef)),
        createdAt: new Date("1990-01-01T00:00:00.000Z"),
      },
    });

    await Promise.all(Array.from({ length: 12 }, () => sweepOutbox(200)));

    expect(
      await db.notification.count({
        where: { institutionId: institution.id, userId: resident.id, entityRef },
      })
    ).toBe(1);

    const completed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(completed.status).toBe("PROCESSED");
    expect(completed.attempts).toBe(0);
    expect(completed.processedAt).not.toBeNull();
    expect(completed.lastError).toBeNull();

    await sweepOutbox(200);
    expect(
      await db.notification.count({
        where: { institutionId: institution.id, userId: resident.id, entityRef },
      })
    ).toBe(1);
  });

  test("concurrent failure recording increments once and reaches FAILED only after five sweeps", async () => {
    const { institution } = await fixture();
    const event = await db.outboxEvent.create({
      data: {
        institutionId: institution.id,
        type: "NOTIFICATION",
        payloadJson: "{not-valid-json",
        createdAt: new Date("1991-01-01T00:00:00.000Z"),
      },
    });

    await Promise.all(Array.from({ length: 10 }, () => sweepOutbox(200)));
    let failed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(failed.status).toBe("PENDING");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain("not valid JSON");

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await sweepOutbox(200);
      failed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(failed.status).toBe("PENDING");
      expect(failed.attempts).toBe(attempt);
    }

    await sweepOutbox(200);
    failed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.attempts).toBe(5);
    expect(failed.processedAt).toBeNull();
  });

  test("one malformed candidate does not starve a later valid notification in the same sweep", async () => {
    const { institution, resident } = await fixture();
    const bad = await db.outboxEvent.create({
      data: {
        institutionId: institution.id,
        type: "NOTIFICATION",
        payloadJson: JSON.stringify({ institutionId: institution.id, userId: 42 }),
        createdAt: new Date("1992-01-01T00:00:00.000Z"),
      },
    });
    const entityRef = unique("later-valid");
    const good = await db.outboxEvent.create({
      data: {
        institutionId: institution.id,
        type: "NOTIFICATION",
        payloadJson: JSON.stringify(notificationPayload(institution.id, resident.id, entityRef)),
        createdAt: new Date("1992-01-01T00:00:01.000Z"),
      },
    });

    await sweepOutbox(200);

    const badAfter = await db.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } });
    const goodAfter = await db.outboxEvent.findUniqueOrThrow({ where: { id: good.id } });
    expect(badAfter.status).toBe("PENDING");
    expect(badAfter.attempts).toBe(1);
    expect(goodAfter.status).toBe("PROCESSED");
    expect(
      await db.notification.count({
        where: { institutionId: institution.id, userId: resident.id, entityRef },
      })
    ).toBe(1);
  });
});
