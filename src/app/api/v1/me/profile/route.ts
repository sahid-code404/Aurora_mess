/**
 * /api/v1/me/profile — the signed-in user's own profile.
 * GET  → { user, profile }
 * PATCH → explicit field mapping ONLY (fullName / phone / roomNumber /
 *         address / emergencyContact). Empty strings clear optional fields.
 * Every change is audited (PROFILE_UPDATED) with a before/after summary.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { fullNameSchema, phoneSchema, roomSchema } from "@/lib/validation";

const profilePatchSchema = z.object({
  fullName: fullNameSchema.optional(),
  phone: phoneSchema.optional(),
  roomNumber: roomSchema.optional(),
  address: z
    .string()
    .trim()
    .max(200, "Keep the address under 200 characters.")
    .optional()
    .or(z.literal("")),
  emergencyContact: z
    .string()
    .trim()
    .max(120, "Keep the emergency contact under 120 characters.")
    .optional()
    .or(z.literal("")),
});

type ProfileUpdate = {
  fullName?: string;
  phone?: string | null;
  roomNumber?: string | null;
  address?: string | null;
  emergencyContact?: string | null;
};

function profileView(profile: {
  fullName: string;
  phone: string | null;
  roomNumber: string | null;
  address: string | null;
  emergencyContact: string | null;
} | null) {
  return profile
    ? {
        fullName: profile.fullName,
        phone: profile.phone,
        roomNumber: profile.roomNumber,
        address: profile.address,
        emergencyContact: profile.emergencyContact,
      }
    : null;
}

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const user = await db.user.findUnique({
    where: { id: ctx.user.id },
    include: { profile: true },
  });
  if (!user) {
    throw new ApiError(CODES.UNAUTHENTICATED, "Please sign in to continue.", 401);
  }
  return {
    data: {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      profile: profileView(user.profile),
    },
  };
});

export const PATCH = route({ auth: "ANY" }, async (ctx) => {
  const user = await db.user.findUnique({
    where: { id: ctx.user.id },
    include: { profile: true },
  });
  if (!user) {
    throw new ApiError(CODES.UNAUTHENTICATED, "Please sign in to continue.", 401);
  }
  const body = await parseBody(ctx.req, profilePatchSchema);

  const updates: ProfileUpdate = {};
  const existing = user.profile;
  if (body.fullName !== undefined && body.fullName !== existing?.fullName) {
    updates.fullName = body.fullName;
  }
  if (body.phone !== undefined && (body.phone || null) !== (existing?.phone ?? null)) {
    updates.phone = body.phone || null;
  }
  if (body.roomNumber !== undefined && (body.roomNumber || null) !== (existing?.roomNumber ?? null)) {
    updates.roomNumber = body.roomNumber || null;
  }
  if (body.address !== undefined && (body.address || null) !== (existing?.address ?? null)) {
    updates.address = body.address || null;
  }
  if (
    body.emergencyContact !== undefined &&
    (body.emergencyContact || null) !== (existing?.emergencyContact ?? null)
  ) {
    updates.emergencyContact = body.emergencyContact || null;
  }

  const before = {
    fullName: existing?.fullName ?? null,
    phone: existing?.phone ?? null,
    roomNumber: existing?.roomNumber ?? null,
    address: existing?.address ?? null,
    emergencyContact: existing?.emergencyContact ?? null,
  };
  const after = {
    ...before,
    ...(updates.fullName !== undefined ? { fullName: updates.fullName } : {}),
    ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
    ...(updates.roomNumber !== undefined ? { roomNumber: updates.roomNumber } : {}),
    ...(updates.address !== undefined ? { address: updates.address } : {}),
    ...(updates.emergencyContact !== undefined
      ? { emergencyContact: updates.emergencyContact }
      : {}),
  };
  const changed = Object.keys(updates);
  const ip = ctx.req.headers.get("x-forwarded-for") ?? null;
  const userAgent = ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null;

  if (!existing) {
    if (!updates.fullName) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
        fullName: "Enter the full name.",
      });
    }
    await db.$transaction(async (tx) => {
      const profile = await tx.userProfile.create({
        data: {
          userId: user.id,
          fullName: updates.fullName as string,
          phone: updates.phone ?? null,
          roomNumber: updates.roomNumber ?? null,
          address: updates.address ?? null,
          emergencyContact: updates.emergencyContact ?? null,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { userProfileId: profile.id } });
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: user.id,
          actorRole: user.role,
          action: "PROFILE_UPDATED",
          entityType: "USER",
          entityId: user.id,
          requestId: ctx.requestId,
          beforeSummary: JSON.stringify(before),
          afterSummary: JSON.stringify(after),
          ip,
          userAgent,
        },
        tx
      );
    });
  } else if (changed.length > 0) {
    const existingProfile = existing;
    await db.$transaction(async (tx) => {
      await tx.userProfile.update({ where: { id: existingProfile.id }, data: updates });
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: user.id,
          actorRole: user.role,
          action: "PROFILE_UPDATED",
          entityType: "USER",
          entityId: user.id,
          requestId: ctx.requestId,
          beforeSummary: JSON.stringify(before),
          afterSummary: JSON.stringify(after),
          ip,
          userAgent,
        },
        tx
      );
    });
  }

  const refreshed = await db.user.findUnique({
    where: { id: user.id },
    include: { profile: true },
  });
  return {
    data: {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      profile: profileView(refreshed?.profile ?? null),
    },
  };
});
