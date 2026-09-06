/**
 * OUTBOX — business state + audit + outbox commit together (spec §73).
 * Notification delivery is asynchronous so delivery failure never rolls back
 * the business mutation that produced the outbox event.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_SWEEP_LIMIT = 200;
const MAX_DELIVERY_ATTEMPTS = 5;

type NotificationPayload = {
  userId: string;
  institutionId: string;
  type: string;
  title: string;
  message: string;
  entityRef?: string;
};

export async function appendOutbox(
  institutionId: string,
  type: string,
  payload: Record<string, unknown>,
  client: any = db
): Promise<void> {
  await client.outboxEvent.create({
    data: { institutionId, type, payloadJson: JSON.stringify(payload) },
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid NOTIFICATION outbox payload: ${field} must be a non-empty string.`);
  }
  return value;
}

function parseNotificationPayload(event: { institutionId: string; payloadJson: string }): NotificationPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(event.payloadJson);
  } catch {
    throw new Error("Invalid NOTIFICATION outbox payload: payloadJson is not valid JSON.");
  }

  if (decoded == null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid NOTIFICATION outbox payload: expected an object.");
  }

  const value = decoded as Record<string, unknown>;
  const institutionId = requiredString(value.institutionId, "institutionId");
  if (institutionId !== event.institutionId) {
    throw new Error("Invalid NOTIFICATION outbox payload: institution boundary mismatch.");
  }

  const entityRef = value.entityRef;
  if (entityRef != null && typeof entityRef !== "string") {
    throw new Error("Invalid NOTIFICATION outbox payload: entityRef must be a string when present.");
  }

  return {
    userId: requiredString(value.userId, "userId"),
    institutionId,
    type: requiredString(value.type, "type"),
    title: requiredString(value.title, "title"),
    message: requiredString(value.message, "message"),
    entityRef: entityRef ?? undefined,
  };
}

async function recordDeliveryFailure(eventId: string, error: unknown): Promise<void> {
  const lastError = String(error).slice(0, 400);
  await db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent"
    SET
      "attempts" = "attempts" + 1,
      "lastError" = ${lastError},
      "status" = CASE
        WHEN "attempts" + 1 >= ${MAX_DELIVERY_ATTEMPTS} THEN 'FAILED'
        ELSE 'PENDING'
      END
    WHERE "id" = ${eventId}
      AND "status" = 'PENDING'
      AND "type" = 'NOTIFICATION'
  `);
}

/**
 * Deliver pending NOTIFICATION events exactly once within PostgreSQL.
 *
 * Each candidate is re-claimed inside an interactive transaction using
 * FOR UPDATE SKIP LOCKED. Notification creation and the PROCESSED transition
 * therefore commit or roll back together, while concurrent request-triggered
 * sweepers cannot deliver the same event at the same time.
 *
 * Delivery failures are counted only after the delivery transaction rolls
 * back. A conditional SQL update prevents a late failure recorder from
 * overwriting an event another sweeper already processed.
 */
export async function sweepOutbox(limit = 50): Promise<void> {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(MAX_SWEEP_LIMIT, Math.floor(limit)))
    : 50;
  if (boundedLimit === 0) return;

  // Freeze the candidate set for this invocation so one malformed event is
  // attempted at most once per sweep and cannot starve later pending events.
  const candidates = await db.outboxEvent.findMany({
    where: { status: "PENDING", type: "NOTIFICATION" },
    select: { id: true },
    take: boundedLimit,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const candidate of candidates) {
    try {
      await db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "OutboxEvent"
          WHERE "id" = ${candidate.id}
            AND "status" = 'PENDING'
            AND "type" = 'NOTIFICATION'
          FOR UPDATE SKIP LOCKED
        `);
        if (locked.length !== 1) return;

        const event = await tx.outboxEvent.findUnique({ where: { id: candidate.id } });
        if (!event || event.status !== "PENDING" || event.type !== "NOTIFICATION") return;

        const payload = parseNotificationPayload(event);
        await tx.notification.create({
          data: {
            userId: payload.userId,
            institutionId: event.institutionId,
            type: payload.type,
            title: payload.title,
            message: payload.message,
            entityRef: payload.entityRef ?? null,
          },
        });

        const completed = await tx.outboxEvent.updateMany({
          where: { id: event.id, status: "PENDING", type: "NOTIFICATION" },
          data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
        });
        if (completed.count !== 1) {
          throw new Error("Outbox event changed before notification delivery could complete.");
        }
      });
    } catch (error) {
      await recordDeliveryFailure(candidate.id, error);
    }
  }
}
