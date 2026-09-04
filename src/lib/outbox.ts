/**
 * OUTBOX — business state + audit + outbox commit together (spec §73).
 * The sweeper processes notifications/email asynchronously so their failure
 * never rolls back an approved payment.
 */
import { db } from "@/lib/db";

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

/**
 * Process pending outbox events (NOTIFICATION type → in-app notifications row).
 * Cheap sweep; safe to call from any request or interval. Idempotent by status.
 */
export async function sweepOutbox(limit = 50): Promise<void> {
  const pending = await db.outboxEvent.findMany({
    where: { status: "PENDING", type: "NOTIFICATION" },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  for (const event of pending) {
    try {
      const payload = JSON.parse(event.payloadJson) as {
        userId: string;
        institutionId: string;
        type: string;
        title: string;
        message: string;
        entityRef?: string;
      };
      await db.notification.create({
        data: {
          userId: payload.userId,
          institutionId: payload.institutionId,
          type: payload.type,
          title: payload.title,
          message: payload.message,
          entityRef: payload.entityRef ?? null,
        },
      });
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
    } catch (error) {
      await db.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          lastError: String(error).slice(0, 400),
          status: event.attempts + 1 >= 5 ? "FAILED" : "PENDING",
        },
      });
    }
  }
}
