/**
 * RESIDENT GUEST MEALS (spec §34, §71) — separate domain from resident meals.
 * POST: add a guest meal request before the instance cutoff (server time).
 * v1 auto-confirms (status CONFIRMED — documented decision); unit price =
 * instance FIXED snapshot price, else institution guest meal price.
 * Idempotent when the client sends an idempotencyKey (double-tap / retry
 * safe — the same key replays the original response instead of charging twice).
 * GET: own list for a date range with meal names + totals. Time-derived states
 * are refreshed before serialization: CONFIRMED → LOCKED → CONSUMED.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { dateKeySchema } from "@/lib/validation";
import { addDaysToKey, dateKeyInTz, formatTimeLabel, localDateMidnightUtc } from "@/lib/time";
import { formatMinor } from "@/lib/money";
import { appendAudit } from "@/lib/audit";
import { claimIdempotencyKey, completeIdempotencyKey, sweepExpiredIdempotencyRecords } from "@/lib/idempotency";
import { keyOfUtcDate, requireInstitutionContext, dayCountBetween } from "@/lib/domain/meal-engine";
import { refreshGuestMealLifecycle } from "@/lib/domain/guest-meal-lifecycle";
import { notifyAdmins, sweepOutboxSafe } from "@/lib/domain/notify";

const IDEMPOTENCY_SCOPE = "GUEST_MEAL_ADD";

const createSchema = z.object({
  mealInstanceId: z.string().min(1),
  quantity: z.coerce.number().int().min(1, "At least 1 guest is required.").max(10, "At most 10 guests per request."),
  note: z.string().trim().max(200).optional(),
  idempotencyKey: z
    .string()
    .min(8, "The idempotency key must be 8–100 characters.")
    .max(100, "The idempotency key must be 8–100 characters.")
    .optional(),
});

const listQuerySchema = z.object({
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});

export const POST = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const body = await parseBody(ctx.req, createSchema);

  const result = await db.$transaction(async (tx) => {
    if (body.idempotencyKey) {
      const claim = await claimIdempotencyKey({
        client: tx,
        institutionId: ctx.institutionId,
        scope: IDEMPOTENCY_SCOPE,
        key: body.idempotencyKey,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      if (claim.state === "REPLAY") {
        return { replay: true as const, payload: claim.payload };
      }
      if (claim.state === "IN_PROGRESS") {
        throw new ApiError(
          CODES.IDPOTENCY_CONFLICT,
          "This request is already being processed. Please try again in a moment.",
          409
        );
      }
    }

    const instance = await tx.mealInstance.findFirst({
      where: { id: body.mealInstanceId, institutionId: ctx.institutionId },
      include: { definition: true },
    });
    if (!instance) throw new ApiError(CODES.NOT_FOUND, "This meal could not be found.", 404);

    const now = new Date();
    if (now.getTime() >= instance.cutoffAt.getTime()) {
      throw new ApiError(
        CODES.MEAL_CUTOFF_PASSED,
        `This meal locked at ${formatTimeLabel(instance.cutoffAt, tz)}. Guest meals can no longer be added.`,
        409
      );
    }

    const unitPriceMinor =
      instance.priceStrategySnapshot === "FIXED" && instance.fixedPriceMinorSnapshot != null
        ? instance.fixedPriceMinorSnapshot
        : inst.settings.guestMealPriceMinor;
    const totalPriceMinor = unitPriceMinor * body.quantity;

    const guest = await tx.guestMealRequest.create({
      data: {
        institutionId: ctx.institutionId,
        hostResidentId: ctx.user.id,
        mealInstanceId: instance.id,
        quantity: body.quantity,
        unitPriceMinor,
        totalPriceMinor,
        note: body.note ?? null,
        status: "CONFIRMED", // v1 auto-confirm (documented)
      },
    });

    const mealName = instance.definition?.name ?? "Meal";
    const serviceDate = keyOfUtcDate(instance.serviceDate);

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "RESIDENT",
        action: "GUEST_MEAL_ADDED",
        entityType: "GUEST_MEAL_REQUEST",
        entityId: guest.id,
        requestId: ctx.requestId,
        afterSummary: JSON.stringify({
          quantity: body.quantity,
          unitPriceMinor,
          totalPriceMinor,
          mealInstanceId: instance.id,
        }),
        metadata: { mealName, serviceDate, note: body.note ?? null },
      },
      tx
    );

    const resident = await tx.user.findUnique({
      where: { id: ctx.user.id },
      include: { profile: true },
    });
    const residentName = resident?.profile?.fullName || ctx.user.email;

    await notifyAdmins(
      ctx.institutionId,
      {
        type: "GUEST_MEAL_BOOKED",
        title: "Guest meals booked",
        message: `${residentName} booked ${body.quantity} guest meal(s) for ${mealName} on ${serviceDate}.`,
        entityRef: guest.id,
      },
      tx
    );

    const payload = {
      id: guest.id,
      mealInstanceId: instance.id,
      mealName,
      serviceDate,
      quantity: guest.quantity,
      unitPriceMinor,
      totalPriceMinor,
      note: guest.note,
      status: guest.status,
      createdAt: guest.createdAt.toISOString(),
    };

    // Persist the replay payload before commit. A concurrent duplicate blocks on
    // the claim row, then observes this exact response after the winner commits.
    if (body.idempotencyKey) {
      await completeIdempotencyKey({
        client: tx,
        institutionId: ctx.institutionId,
        scope: IDEMPOTENCY_SCOPE,
        key: body.idempotencyKey,
        payload,
      });
    }

    return { replay: false as const, payload };
  });

  if (result.replay) {
    return { data: result.payload, meta: { idempotentReplay: true } };
  }

  await sweepOutboxSafe();
  // Opportunistic retention must not affect the committed guest booking.
  await sweepExpiredIdempotencyRecords({ institutionId: ctx.institutionId }).catch(() => 0);
  return { data: result.payload };
});

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await requireInstitutionContext(ctx.institutionId);
  const tz = inst.timezone;
  const todayKey = dateKeyInTz(new Date(), tz);

  const raw: Record<string, string> = {};
  for (const [k, v] of ctx.req.nextUrl.searchParams.entries()) raw[k] = v;
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the date filters.", 400, {
      from: "Dates use the YYYY-MM-DD format.",
      to: "Dates use the YYYY-MM-DD format.",
    });
  }
  const from = parsed.data.from ?? addDaysToKey(todayKey, -30);
  const to = parsed.data.to ?? addDaysToKey(todayKey, 7);
  if (from > to || dayCountBetween(from, to) > 92) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please choose a valid range of 92 days or fewer.", 400);
  }

  const fromDate = localDateMidnightUtc(from);
  const toDate = new Date(localDateMidnightUtc(to).getTime() + 86_400_000 - 1);
  await refreshGuestMealLifecycle({
    institutionId: ctx.institutionId,
    hostResidentId: ctx.user.id,
    from: fromDate,
    to: toDate,
  });

  const rows = await db.guestMealRequest.findMany({
    where: {
      institutionId: ctx.institutionId,
      hostResidentId: ctx.user.id,
      mealInstance: { serviceDate: { gte: fromDate, lte: toDate } },
    },
    include: { mealInstance: { include: { definition: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const items = rows.map((g) => ({
    id: g.id,
    mealInstanceId: g.mealInstanceId,
    mealName: g.mealInstance.definition?.name ?? "Meal",
    serviceDate: keyOfUtcDate(g.mealInstance.serviceDate),
    quantity: g.quantity,
    unitPriceMinor: g.unitPriceMinor,
    totalPriceMinor: g.totalPriceMinor,
    note: g.note,
    status: g.status,
    createdAt: g.createdAt.toISOString(),
    /** Instance cutoff instant — the client renders the "under cutoff" state. */
    cutoffAt: g.mealInstance.cutoffAt.toISOString(),
  }));

  const active = items.filter((i) => i.status !== "CANCELLED");
  return {
    data: items,
    meta: {
      from,
      to,
      timezone: tz,
      totalQuantity: active.reduce((s, i) => s + i.quantity, 0),
      totalAmountMinor: active.reduce((s, i) => s + i.totalPriceMinor, 0),
    },
  };
});
