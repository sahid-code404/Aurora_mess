/**
 * GET /api/v1/auth/me — current session context for the app shell.
 * Returns user, profile and institution display fields.
 */
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { touchSession } from "@/lib/auth/session";
import { getInstitution } from "@/lib/institution";

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const [user, institution] = await Promise.all([
    db.user.findUnique({ where: { id: ctx.user.id }, include: { profile: true } }),
    getInstitution(ctx.institutionId),
  ]);
  if (!user) {
    throw new ApiError(CODES.UNAUTHENTICATED, "Please sign in to continue.", 401);
  }
  await touchSession(ctx.user.sessionId); // cheap lastSeen update, never fails

  return {
    data: {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        institutionId: user.institutionId,
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
      institution: institution
        ? {
            name: institution.name,
            timezone: institution.timezone,
            currencyCode: institution.currencyCode,
            currencyMinorDigits: institution.currencyMinorDigits,
          }
        : null,
    },
  };
});
