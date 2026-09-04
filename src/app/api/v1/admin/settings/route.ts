/**
 * /api/v1/admin/settings — institution settings + financial policy + security.
 * GET   → { institution, settings, security }
 * PATCH → explicit fields only. Money fields (deficitThresholdMinor,
 *         guestMealPriceMinor) are submitted as DECIMAL STRINGS ("1000.00")
 *         and converted to integer minor units server-side via
 *         parseDecimalToMinor — clients never send computed integers.
 * Every change is audited (SETTINGS_UPDATED, before/after) and the
 * institution cache is invalidated.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { invalidateInstitutionCache } from "@/lib/institution";
import { parseDecimalToMinor } from "@/lib/money";

const settingsPatchSchema = z.object({
  name: z.string().trim().min(2, "Institution name is too short.").max(120).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  currencyCode: z
    .string()
    .trim()
    .length(3, "Currency codes are 3 letters (e.g. INR).")
    .transform((v) => v.toUpperCase())
    .optional(),
  currencyMinorDigits: z.coerce.number().int().min(0).max(2).optional(),
  settings: z
    .object({
      deficitThresholdMinor: z.string().trim().min(1).optional(),
      gracePeriodDays: z.coerce.number().int().min(0).max(180).optional(),
      restrictMealsOnDeficit: z.boolean().optional(),
      deficitPolicyEnabled: z.boolean().optional(),
      billingDueDays: z.coerce.number().int().min(0).max(90).optional(),
      guestMealPriceMinor: z.string().trim().min(1).optional(),
    })
    .optional(),
  security: z
    .object({
      maxLoginAttempts: z.coerce.number().int().min(1).max(100).optional(),
      loginWindowMinutes: z.coerce.number().int().min(1).max(1440).optional(),
      sessionIdleMinutes: z.coerce.number().int().min(5).max(525600).optional(),
      sensitiveActionMinutes: z.coerce.number().int().min(1).max(1440).optional(),
      requireReasonOnOverride: z.boolean().optional(),
    })
    .optional(),
});

type InstitutionUpdate = {
  name?: string;
  timezone?: string;
  currencyCode?: string;
  currencyMinorDigits?: number;
};
type SettingsUpdate = {
  deficitThresholdMinor?: number;
  gracePeriodDays?: number;
  restrictMealsOnDeficit?: boolean;
  deficitPolicyEnabled?: boolean;
  billingDueDays?: number;
  guestMealPriceMinor?: number;
};
type SecurityUpdate = {
  maxLoginAttempts?: number;
  loginWindowMinutes?: number;
  sessionIdleMinutes?: number;
  sensitiveActionMinutes?: number;
  requireReasonOnOverride?: boolean;
};

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseAmountToMinor(value: string, field: string): number {
  const minor = parseDecimalToMinor(value);
  if (minor === null || minor < 0) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
      [field]: "Enter a valid non-negative amount, e.g. 1000.00",
    });
  }
  return minor;
}

async function loadInstitution(institutionId: string) {
  const institution = await db.institution.findUnique({
    where: { id: institutionId },
    include: { settings: true, securitySettings: true },
  });
  if (!institution) {
    throw new ApiError(CODES.NOT_FOUND, "Institution not found.", 404);
  }
  return institution;
}

function view(institution: Awaited<ReturnType<typeof loadInstitution>>) {
  return {
    institution: {
      name: institution.name,
      timezone: institution.timezone,
      currencyCode: institution.currencyCode,
      currencyMinorDigits: institution.currencyMinorDigits,
    },
    settings: institution.settings
      ? {
          deficitThresholdMinor: institution.settings.deficitThresholdMinor,
          gracePeriodDays: institution.settings.gracePeriodDays,
          restrictMealsOnDeficit: institution.settings.restrictMealsOnDeficit,
          deficitPolicyEnabled: institution.settings.deficitPolicyEnabled,
          billingDueDays: institution.settings.billingDueDays,
          guestMealPriceMinor: institution.settings.guestMealPriceMinor,
        }
      : null,
    security: institution.securitySettings
      ? {
          maxLoginAttempts: institution.securitySettings.maxLoginAttempts,
          loginWindowMinutes: institution.securitySettings.loginWindowMinutes,
          sessionIdleMinutes: institution.securitySettings.sessionIdleMinutes,
          sensitiveActionMinutes: institution.securitySettings.sensitiveActionMinutes,
          requireReasonOnOverride: institution.securitySettings.requireReasonOnOverride,
        }
      : null,
  };
}

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const institution = await loadInstitution(ctx.institutionId);
  return { data: view(institution) };
});

export const PATCH = route({ auth: "ADMIN" }, async (ctx) => {
  const institution = await loadInstitution(ctx.institutionId);
  const body = await parseBody(ctx.req, settingsPatchSchema);

  const changes: { field: string; before: unknown; after: unknown }[] = [];

  const institutionUpdate: InstitutionUpdate = {};
  if (body.name !== undefined && body.name !== institution.name) {
    institutionUpdate.name = body.name;
    changes.push({ field: "name", before: institution.name, after: body.name });
  }
  if (body.timezone !== undefined && body.timezone !== institution.timezone) {
    if (!isValidTimezone(body.timezone)) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Please check the highlighted fields.", 400, {
        timezone: "This time zone is not recognized.",
      });
    }
    institutionUpdate.timezone = body.timezone;
    changes.push({ field: "timezone", before: institution.timezone, after: body.timezone });
  }
  if (body.currencyCode !== undefined && body.currencyCode !== institution.currencyCode) {
    institutionUpdate.currencyCode = body.currencyCode;
    changes.push({
      field: "currencyCode",
      before: institution.currencyCode,
      after: body.currencyCode,
    });
  }
  if (
    body.currencyMinorDigits !== undefined &&
    body.currencyMinorDigits !== institution.currencyMinorDigits
  ) {
    institutionUpdate.currencyMinorDigits = body.currencyMinorDigits;
    changes.push({
      field: "currencyMinorDigits",
      before: institution.currencyMinorDigits,
      after: body.currencyMinorDigits,
    });
  }

  const currentSettings = {
    deficitThresholdMinor: institution.settings?.deficitThresholdMinor ?? 100000,
    gracePeriodDays: institution.settings?.gracePeriodDays ?? 7,
    restrictMealsOnDeficit: institution.settings?.restrictMealsOnDeficit ?? true,
    deficitPolicyEnabled: institution.settings?.deficitPolicyEnabled ?? true,
    billingDueDays: institution.settings?.billingDueDays ?? 10,
    guestMealPriceMinor: institution.settings?.guestMealPriceMinor ?? 5500,
  };
  const settingsUpdate: SettingsUpdate = {};
  if (body.settings) {
    if (body.settings.deficitThresholdMinor !== undefined) {
      const minor = parseAmountToMinor(body.settings.deficitThresholdMinor, "settings.deficitThresholdMinor");
      if (minor !== currentSettings.deficitThresholdMinor) {
        settingsUpdate.deficitThresholdMinor = minor;
        changes.push({
          field: "settings.deficitThresholdMinor",
          before: currentSettings.deficitThresholdMinor,
          after: minor,
        });
      }
    }
    if (body.settings.gracePeriodDays !== undefined && body.settings.gracePeriodDays !== currentSettings.gracePeriodDays) {
      settingsUpdate.gracePeriodDays = body.settings.gracePeriodDays;
      changes.push({
        field: "settings.gracePeriodDays",
        before: currentSettings.gracePeriodDays,
        after: body.settings.gracePeriodDays,
      });
    }
    if (body.settings.restrictMealsOnDeficit !== undefined && body.settings.restrictMealsOnDeficit !== currentSettings.restrictMealsOnDeficit) {
      settingsUpdate.restrictMealsOnDeficit = body.settings.restrictMealsOnDeficit;
      changes.push({
        field: "settings.restrictMealsOnDeficit",
        before: currentSettings.restrictMealsOnDeficit,
        after: body.settings.restrictMealsOnDeficit,
      });
    }
    if (body.settings.deficitPolicyEnabled !== undefined && body.settings.deficitPolicyEnabled !== currentSettings.deficitPolicyEnabled) {
      settingsUpdate.deficitPolicyEnabled = body.settings.deficitPolicyEnabled;
      changes.push({
        field: "settings.deficitPolicyEnabled",
        before: currentSettings.deficitPolicyEnabled,
        after: body.settings.deficitPolicyEnabled,
      });
    }
    if (body.settings.billingDueDays !== undefined && body.settings.billingDueDays !== currentSettings.billingDueDays) {
      settingsUpdate.billingDueDays = body.settings.billingDueDays;
      changes.push({
        field: "settings.billingDueDays",
        before: currentSettings.billingDueDays,
        after: body.settings.billingDueDays,
      });
    }
    if (body.settings.guestMealPriceMinor !== undefined) {
      const minor = parseAmountToMinor(body.settings.guestMealPriceMinor, "settings.guestMealPriceMinor");
      if (minor !== currentSettings.guestMealPriceMinor) {
        settingsUpdate.guestMealPriceMinor = minor;
        changes.push({
          field: "settings.guestMealPriceMinor",
          before: currentSettings.guestMealPriceMinor,
          after: minor,
        });
      }
    }
  }

  const currentSecurity = {
    maxLoginAttempts: institution.securitySettings?.maxLoginAttempts ?? 8,
    loginWindowMinutes: institution.securitySettings?.loginWindowMinutes ?? 15,
    sessionIdleMinutes: institution.securitySettings?.sessionIdleMinutes ?? 43200,
    sensitiveActionMinutes: institution.securitySettings?.sensitiveActionMinutes ?? 15,
    requireReasonOnOverride: institution.securitySettings?.requireReasonOnOverride ?? true,
  };
  const securityUpdate: SecurityUpdate = {};
  if (body.security) {
    if (body.security.maxLoginAttempts !== undefined && body.security.maxLoginAttempts !== currentSecurity.maxLoginAttempts) {
      securityUpdate.maxLoginAttempts = body.security.maxLoginAttempts;
      changes.push({ field: "security.maxLoginAttempts", before: currentSecurity.maxLoginAttempts, after: body.security.maxLoginAttempts });
    }
    if (body.security.loginWindowMinutes !== undefined && body.security.loginWindowMinutes !== currentSecurity.loginWindowMinutes) {
      securityUpdate.loginWindowMinutes = body.security.loginWindowMinutes;
      changes.push({ field: "security.loginWindowMinutes", before: currentSecurity.loginWindowMinutes, after: body.security.loginWindowMinutes });
    }
    if (body.security.sessionIdleMinutes !== undefined && body.security.sessionIdleMinutes !== currentSecurity.sessionIdleMinutes) {
      securityUpdate.sessionIdleMinutes = body.security.sessionIdleMinutes;
      changes.push({ field: "security.sessionIdleMinutes", before: currentSecurity.sessionIdleMinutes, after: body.security.sessionIdleMinutes });
    }
    if (body.security.sensitiveActionMinutes !== undefined && body.security.sensitiveActionMinutes !== currentSecurity.sensitiveActionMinutes) {
      securityUpdate.sensitiveActionMinutes = body.security.sensitiveActionMinutes;
      changes.push({ field: "security.sensitiveActionMinutes", before: currentSecurity.sensitiveActionMinutes, after: body.security.sensitiveActionMinutes });
    }
    if (body.security.requireReasonOnOverride !== undefined && body.security.requireReasonOnOverride !== currentSecurity.requireReasonOnOverride) {
      securityUpdate.requireReasonOnOverride = body.security.requireReasonOnOverride;
      changes.push({ field: "security.requireReasonOnOverride", before: currentSecurity.requireReasonOnOverride, after: body.security.requireReasonOnOverride });
    }
  }

  if (changes.length > 0) {
    const beforeSummary = JSON.stringify(
      Object.fromEntries(changes.map((c) => [c.field, c.before]))
    );
    const afterSummary = JSON.stringify(
      Object.fromEntries(changes.map((c) => [c.field, c.after]))
    );
    await db.$transaction(async (tx) => {
      if (Object.keys(institutionUpdate).length > 0) {
        await tx.institution.update({ where: { id: institution.id }, data: institutionUpdate });
      }
      if (Object.keys(settingsUpdate).length > 0) {
        await tx.institutionSettings.upsert({
          where: { institutionId: institution.id },
          create: { institutionId: institution.id, ...settingsUpdate },
          update: settingsUpdate,
        });
      }
      if (Object.keys(securityUpdate).length > 0) {
        await tx.institutionSecuritySettings.upsert({
          where: { institutionId: institution.id },
          create: { institutionId: institution.id, ...securityUpdate },
          update: securityUpdate,
        });
      }
      await appendAudit(
        {
          institutionId: ctx.institutionId,
          actorUserId: ctx.user.id,
          actorRole: "ADMIN",
          action: "SETTINGS_UPDATED",
          entityType: "INSTITUTION",
          entityId: institution.id,
          requestId: ctx.requestId,
          beforeSummary,
          afterSummary,
          ip: ctx.req.headers.get("x-forwarded-for") ?? null,
          userAgent: ctx.req.headers.get("user-agent")?.slice(0, 250) ?? null,
        },
        tx
      );
    });
    invalidateInstitutionCache();
  }

  const refreshed = await loadInstitution(ctx.institutionId);
  return { data: view(refreshed) };
});
