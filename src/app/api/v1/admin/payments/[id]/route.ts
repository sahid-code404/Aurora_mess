/**
 * GET /api/v1/admin/payments/[id] — payment detail for the review page
 * (auth ADMIN, spec §133): payment + resident identity + the resident's funds
 * summary so the reviewer sees deposits/charges/available in context.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { formatMinor } from "@/lib/money";
import { serializePayment } from "@/lib/domain/serialize";
import { residentFundsSummary } from "@/lib/domain/funds";
import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const payment = await db.payment.findFirst({
    where: { id: ctx.params.id, institutionId: ctx.institutionId },
    include: { history: { orderBy: { createdAt: "asc" } } },
  });
  if (!payment) throw new ApiError(CODES.NOT_FOUND, "Payment not found.", 404);

  const [resident, profile] = await Promise.all([
    db.user.findUnique({ where: { id: payment.residentId }, select: { id: true, email: true, status: true } }),
    db.userProfile.findUnique({ where: { userId: payment.residentId }, select: { fullName: true, roomNumber: true } }),
  ]);
  const summary = await residentFundsSummary(payment.residentId);

  sweepOutbox(20).catch(() => {});

  return {
    data: {
      payment: serializePayment(payment),
      history: payment.history.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus ?? null,
        toStatus: h.toStatus,
        changedByUserId: h.changedByUserId ?? null,
        reason: h.reason ?? null,
        createdAt: h.createdAt.toISOString(),
      })),
      resident: resident
        ? {
            id: resident.id,
            email: resident.email,
            status: resident.status,
            fullName: profile?.fullName ?? "Resident",
            roomNumber: profile?.roomNumber ?? null,
          }
        : null,
      residentFunds: {
        ...summary,
        availableFormatted: formatMinor(summary.availableMinor),
        creditsFormatted: formatMinor(summary.creditsMinor),
        pendingPaymentsFormatted: formatMinor(summary.pendingPaymentsMinor),
        chargesFormatted: formatMinor(summary.chargesMinor),
        amountToPayFormatted: formatMinor(summary.amountToPayMinor),
        deficitFormatted: formatMinor(summary.deficitMinor),
      },
    },
  };
});
