/**
 * GET /api/v1/admin/residents/[id] — Resident 360° (spec §135).
 * Everything about one resident in a single response, fetched in parallel:
 * user + profile, status history, membership dates, derived funds summary,
 * last 10 payments (displayNumber), last 5 bills (with line counts),
 * last 5 tasks, last 5 leave requests, and the last 15 audit events
 * recorded about this user (entityType=USER, entityId=id).
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { residentFundsSummary } from "@/lib/domain/funds";
import { hashPassword } from "@/lib/auth/password";
import { appendAudit } from "@/lib/audit";
import { formatMinor } from "@/lib/money";
import { getInstitution } from "@/lib/institution";
import { zonedTimeToUtc } from "@/lib/time";
import { effectiveBillStatus } from "@/lib/domain/bill-status";

const updateResidentSchema = z.object({
  fullName: z.string().trim().min(2, "Name must be at least 2 characters.").max(80).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  roomNumber: z.string().trim().max(30).nullable().optional(),
  emergencyContact: z.string().trim().max(100).nullable().optional(),
  password: z.string().min(6, "Password must be at least 6 characters.").max(100).optional(),
  membershipEffectiveFrom: z.union([z.string().min(4).max(40), z.null()]).optional(),
  membershipEffectiveUntil: z.union([z.string().min(4).max(40), z.null()]).optional(),
});

function parseIso(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
      [field]: "Enter a valid date.",
    });
  }
  return date;
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const user = await db.user.findFirst({
    where: { id, institutionId: ctx.institutionId, role: "RESIDENT" },
    include: { profile: true },
  });
  if (!user) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }

  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const statusNow = new Date();

  const [statusHistory, funds, payments, bills, tasks, leave, audit, refunds] = await Promise.all([
    db.userStatusHistory.findMany({
      where: { userId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    residentFundsSummary(id),
    db.payment.findMany({
      where: { institutionId: ctx.institutionId, residentId: id },
      orderBy: { submittedAt: "desc" },
      take: 10,
      select: {
        id: true,
        displayNumber: true,
        amountMinor: true,
        method: true,
        reference: true,
        status: true,
        submittedAt: true,
      },
    }),
    db.bill.findMany({
      where: { institutionId: ctx.institutionId, residentId: id },
      orderBy: { generatedAt: "desc" },
      take: 5,
      include: { _count: { select: { lines: true } } },
    }),
    db.task.findMany({
      where: { institutionId: ctx.institutionId, assignedResidentId: id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        description: true,
        status: true,
        dueDate: true,
        estimatedAmountMinor: true,
        createdAt: true,
      },
    }),
    db.leaveRequest.findMany({
      where: { institutionId: ctx.institutionId, residentId: id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        startDate: true,
        endDate: true,
        reason: true,
        status: true,
        createdAt: true,
      },
    }),
    db.auditEvent.findMany({
      where: { institutionId: ctx.institutionId, entityType: "USER", entityId: id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 15,
    }),
    db.refund.findMany({
      where: { institutionId: ctx.institutionId, residentId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 15,
    }),
  ]);

  return {
    data: {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        membershipEffectiveFrom: user.membershipEffectiveFrom,
        membershipEffectiveUntil: user.membershipEffectiveUntil,
      },
      profile: user.profile
        ? {
            fullName: user.profile.fullName,
            phone: user.profile.phone,
            roomNumber: user.profile.roomNumber,
            address: user.profile.address,
            emergencyContact: user.profile.emergencyContact,
          }
        : null,
      statusHistory: statusHistory.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        reason: h.reason,
        changedByUserId: h.changedByUserId,
        createdAt: h.createdAt,
      })),
      funds,
      payments,
      refunds: refunds.map((r) => ({
        id: r.id,
        amountMinor: r.amountMinor,
        amountFormatted: formatMinor(r.amountMinor),
        mode: r.mode,
        status: r.status,
        reason: r.reason,
        destination: r.destination,
        reversalJournalId: r.reversalJournalId,
        voidReason: r.voidReason,
        voidedByUserId: r.voidedByUserId,
        voidedAt: r.voidedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
      })),
      bills: bills.map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        status: effectiveBillStatus(b, timeZone, statusNow),
        totalDueMinor: b.totalDueMinor,
        subtotalMinor: b.subtotalMinor,
        dueDate: b.dueDate,
        generatedAt: b.generatedAt,
        lineCount: b._count.lines,
      })),
      tasks,
      leave,
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        actorRole: a.actorRole,
        actorUserId: a.actorUserId,
        reason: a.reason,
        beforeSummary: a.beforeSummary,
        afterSummary: a.afterSummary,
        occurredAt: a.occurredAt,
        requestId: a.requestId,
      })),
    },
  };
});

export const PATCH = route({ auth: "ADMIN" }, async (ctx) => {
  const id = ctx.params.id;
  const user = await db.user.findFirst({
    where: { id, institutionId: ctx.institutionId, role: "RESIDENT" },
    include: { profile: true },
  });
  if (!user) {
    throw new ApiError(CODES.NOT_FOUND, "Resident not found.", 404);
  }

  const body = await parseBody(ctx.req, updateResidentSchema);

  // Validate membership dates if provided
  let newFrom = user.membershipEffectiveFrom;
  if (body.membershipEffectiveFrom !== undefined) {
    newFrom = body.membershipEffectiveFrom === null ? null : parseIso(body.membershipEffectiveFrom, "membershipEffectiveFrom");
  }

  let newUntil = user.membershipEffectiveUntil;
  if (body.membershipEffectiveUntil !== undefined) {
    newUntil = body.membershipEffectiveUntil === null ? null : parseIso(body.membershipEffectiveUntil, "membershipEffectiveUntil");
  }

  if (newFrom && newUntil && newUntil < newFrom) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
      membershipEffectiveUntil: "The end date must be on or after the start date.",
    });
  }

  // Guard against rewriting closed billing periods
  const fromChanging = newFrom !== null && newFrom.getTime() !== user.membershipEffectiveFrom?.getTime();
  if (fromChanging && newFrom) {
    const institution = await getInstitution(ctx.institutionId);
    const timezone = institution?.timezone ?? "UTC";
    const billedPeriods = await db.billingPeriod.findMany({
      where: { institutionId: ctx.institutionId, status: "BILLED" },
      select: { year: true, month: true },
    });
    const billedStarts = billedPeriods.map((p) => zonedTimeToUtc(p.year, p.month, 1, 0, 0, timezone));
    if (billedStarts.some((start) => newFrom < start)) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        "Changing membership into a closed billing period is restricted.",
        409
      );
    }
  }

  let newPasswordHash: string | undefined = undefined;
  if (body.password && body.password.trim().length > 0) {
    newPasswordHash = await hashPassword(body.password.trim());
  }

  const before = {
    fullName: user.profile?.fullName,
    phone: user.profile?.phone,
    roomNumber: user.profile?.roomNumber,
    emergencyContact: user.profile?.emergencyContact,
    membershipEffectiveFrom: user.membershipEffectiveFrom,
    membershipEffectiveUntil: user.membershipEffectiveUntil,
    passwordChanged: false,
  };

  const after = {
    fullName: body.fullName ?? user.profile?.fullName,
    phone: body.phone !== undefined ? body.phone : user.profile?.phone,
    roomNumber: body.roomNumber !== undefined ? body.roomNumber : user.profile?.roomNumber,
    emergencyContact: body.emergencyContact !== undefined ? body.emergencyContact : user.profile?.emergencyContact,
    membershipEffectiveFrom: newFrom,
    membershipEffectiveUntil: newUntil,
    passwordChanged: Boolean(newPasswordHash),
  };

  await db.$transaction(async (tx) => {
    // 1. Update user
    const userUpdates: Record<string, unknown> = {};
    if (body.membershipEffectiveFrom !== undefined) userUpdates.membershipEffectiveFrom = newFrom;
    if (body.membershipEffectiveUntil !== undefined) userUpdates.membershipEffectiveUntil = newUntil;
    if (newPasswordHash) userUpdates.passwordHash = newPasswordHash;

    // 2. Update profile
    const profileUpdates: Record<string, unknown> = {};
    if (body.fullName !== undefined) profileUpdates.fullName = body.fullName;
    if (body.phone !== undefined) profileUpdates.phone = body.phone;
    if (body.roomNumber !== undefined) profileUpdates.roomNumber = body.roomNumber;
    if (body.emergencyContact !== undefined) profileUpdates.emergencyContact = body.emergencyContact;

    if (Object.keys(profileUpdates).length > 0) {
      if (user.profile) {
        await tx.userProfile.update({
          where: { id: user.profile.id },
          data: profileUpdates,
        });
      } else {
        const createdProfile = await tx.userProfile.create({
          data: {
            userId: id,
            fullName: body.fullName ?? user.email.split("@")[0],
            phone: body.phone ?? null,
            roomNumber: body.roomNumber ?? null,
            emergencyContact: body.emergencyContact ?? null,
          },
        });
        userUpdates.userProfileId = createdProfile.id;
      }
    }

    if (Object.keys(userUpdates).length > 0) {
      await tx.user.update({
        where: { id },
        data: userUpdates,
      });
    }

    // Revoke active sessions if password changed
    if (newPasswordHash) {
      await tx.session.deleteMany({
        where: { userId: id },
      });
    }

    await appendAudit(
      {
        institutionId: ctx.institutionId,
        actorUserId: ctx.user.id,
        actorRole: "ADMIN",
        action: "RESIDENT_EDITED",
        entityType: "USER",
        entityId: id,
        beforeSummary: JSON.stringify(before),
        afterSummary: JSON.stringify(after),
      },
      tx
    );
  });

  return { data: { success: true, message: "Resident details updated." } };
});
