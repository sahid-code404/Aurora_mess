/**
 * GET /api/v1/me/dashboard — the resident home view (auth RESIDENT, §205-208):
 * greeting with the resident's name; KPIs (my meals today, available balance,
 * current amount to pay, derived payment status); today's meals with my state
 * + cutoff countdown info (server instants; the client renders the countdown);
 * today's GUEST meals (self-service under cutoff) so the current-day agenda
 * view can show the guest row above breakfast/lunch/dinner; recent activity =
 * my last 8 notifications; pinned announcements.
 */
import { route } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { formatMinor } from "@/lib/money";
import { dateKeyInTz, greetingFor, localDateMidnightUtc, partsInTz } from "@/lib/time";
import { residentFundsSummary } from "@/lib/domain/funds";
import { derivePaymentStatus } from "@/lib/domain/billing";
import { serializeNotification } from "@/lib/domain/serialize";
import { sweepOutbox } from "@/lib/outbox";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "RESIDENT" }, async (ctx) => {
  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const now = new Date();
  const parts = partsInTz(now, tz);
  const greeting = greetingFor(parts.hour);
  const todayKey = dateKeyInTz(now, tz);
  const todayMidnight = localDateMidnightUtc(todayKey);
  const monthPrefix = todayKey.slice(0, 7);
  const monthStart = localDateMidnightUtc(`${monthPrefix}-01`);
  const [y, m] = monthPrefix.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = localDateMidnightUtc(`${monthPrefix}-${String(lastDay).padStart(2, "0")}`);

  const [
    profile,
    summary,
    unsettledBills,
    notifications,
    pinnedAnnouncements,
    todayInstances,
    myMealsToday,
    todayGuestRequests,
    monthlyMealCount,
  ] = await Promise.all([
      db.userProfile.findUnique({ where: { userId: ctx.user.id }, select: { fullName: true, roomNumber: true } }),
      residentFundsSummary(ctx.user.id),
      db.bill.findMany({
        where: { residentId: ctx.user.id, status: { in: ["GENERATED", "PARTIALLY_PAID", "OVERDUE"] } },
        select: { status: true, dueDate: true },
      }),
      db.notification.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.announcement.findMany({
        where: {
          institutionId: ctx.institutionId,
          pinned: true,
          target: { in: ["EVERYONE", "RESIDENTS"] },
          publishAt: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ priority: "desc" }, { publishAt: "desc" }],
        take: 5,
      }),
      db.mealInstance.findMany({
        where: { institutionId: ctx.institutionId, serviceDate: todayMidnight },
        include: { definition: { select: { name: true, icon: true, mealType: true, colorToken: true } } },
        orderBy: { serviceStartAt: "asc" },
      }),
      db.residentMeal.findMany({
        where: {
          institutionId: ctx.institutionId,
          residentId: ctx.user.id,
          mealInstance: { serviceDate: todayMidnight },
        },
        select: { mealInstanceId: true, effectiveState: true, effectiveReason: true, version: true },
      }),
      // Today's guest meals (non-cancelled) for the agenda guest row.
      db.guestMealRequest.findMany({
        where: {
          institutionId: ctx.institutionId,
          hostResidentId: ctx.user.id,
          status: { not: "CANCELLED" },
          mealInstance: { serviceDate: todayMidnight },
        },
        include: { mealInstance: { include: { definition: { select: { name: true } } } } },
        orderBy: { createdAt: "asc" },
      }),
      db.residentMeal.count({
        where: {
          institutionId: ctx.institutionId,
          residentId: ctx.user.id,
          effectiveState: "ON",
          mealInstance: { serviceDate: { gte: monthStart, lte: monthEnd } },
        },
      }),
    ]);

  sweepOutbox(20).catch(() => {});

  const myMealMap = new Map(myMealsToday.map((m) => [m.mealInstanceId, m]));
  const paymentStatus = derivePaymentStatus(unsettledBills, tz, now);
  const mealsToday = myMealsToday.filter((m) => m.effectiveState === "ON").length;

  return {
    data: {
      greeting: {
        text: greeting.text,
        icon: greeting.icon,
        fullName: profile?.fullName ?? "Resident",
        localTime: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
      },
      monthlyMealCount,
      kpis: {
        mealsToday,
        monthlyMealCount,
        availableBalance: summary.availableMinor,
        availableBalanceFormatted: formatMinor(summary.availableMinor),
        currentAmountToPay: summary.amountToPayMinor,
        currentAmountToPayFormatted: formatMinor(summary.amountToPayMinor),
        paymentStatus,
      },
      todayMeals: todayInstances.map((instance) => {
        const mine = myMealMap.get(instance.id);
        return {
          id: instance.id,
          mealName: instance.definition?.name ?? "Meal",
          icon: instance.definition?.icon ?? null,
          colorToken: instance.definition?.colorToken ?? null,
          mealType: instance.definition?.mealType ?? "REGULAR",
          serviceStartAt: instance.serviceStartAt.toISOString(),
          serviceEndAt: instance.serviceEndAt.toISOString(),
          cutoffAt: instance.cutoffAt.toISOString(),
          lockAt: instance.lockAt.toISOString(),
          locked: now > instance.cutoffAt,
          instanceStatus: instance.status,
          myState: mine?.effectiveState ?? null,
          myReason: mine?.effectiveReason ?? null,
          myVersion: mine?.version ?? null,
        };
      }),
      todayGuests: todayGuestRequests.map((g) => ({
        id: g.id,
        mealInstanceId: g.mealInstanceId,
        mealName: g.mealInstance.definition?.name ?? "Meal",
        quantity: g.quantity,
        unitPriceMinor: g.unitPriceMinor,
        totalPriceMinor: g.totalPriceMinor,
        note: g.note,
        status: g.status,
        cutoffAt: g.mealInstance.cutoffAt.toISOString(),
      })),
      recentActivity: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        entityRef: n.entityRef ?? null,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      pinnedAnnouncements: pinnedAnnouncements.map((a) => ({
        id: a.id,
        title: a.title,
        message: a.message,
        type: a.type,
        priority: a.priority,
        publishAt: a.publishAt.toISOString(),
      })),
      notificationsPreview: notifications.slice(0, 3).map((n) => serializeNotification(n)),
    },
  };
});
