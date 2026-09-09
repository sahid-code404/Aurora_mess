/**
 * BILLING PUBLICATION WINDOW
 *
 * Billing calculations stay live while a period is OPEN. Publishing is a
 * separate lifecycle boundary: the month must have ended and the institution's
 * configured publication day in the following month must have arrived.
 *
 * The publication day is stored through the existing VariableDefinition /
 * CustomVariableValue history instead of introducing another settings table.
 * It is exposed to Admins as the editable `billing_publish_day` system variable.
 */
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { getInstitution } from "@/lib/institution";
import { zonedTimeToUtc } from "@/lib/time";
import { periodBounds } from "./formula/period-variables";

export const BILLING_PUBLISH_DAY_KEY = "billing_publish_day";
export const DEFAULT_BILLING_PUBLISH_DAY = 5;
export const MIN_BILLING_PUBLISH_DAY = 1;
export const MAX_BILLING_PUBLISH_DAY = 28;

export type BillingPublicationState = "LIVE" | "WAITING" | "READY" | "PUBLISHED";

export type BillingPublicationWindow = {
  state: BillingPublicationState;
  publishDay: number;
  publishAt: Date;
  monthEnded: boolean;
  windowOpen: boolean;
};

export function normalizeBillingPublishDay(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BILLING_PUBLISH_DAY;
  const day = Math.round(n);
  if (day < MIN_BILLING_PUBLISH_DAY || day > MAX_BILLING_PUBLISH_DAY) {
    return DEFAULT_BILLING_PUBLISH_DAY;
  }
  return day;
}

export function billingPublishAt(
  year: number,
  month: number,
  publishDay = DEFAULT_BILLING_PUBLISH_DAY,
  timeZone = "Asia/Kolkata"
): Date {
  const day = normalizeBillingPublishDay(publishDay);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return zonedTimeToUtc(nextYear, nextMonth, day, 0, 0, timeZone);
}

export function billingPublicationWindow(params: {
  year: number;
  month: number;
  publishDay?: number;
  timeZone?: string;
  now?: Date;
  periodStatus?: string;
}): BillingPublicationWindow {
  const timeZone = params.timeZone ?? "Asia/Kolkata";
  const now = params.now ?? new Date();
  const publishDay = normalizeBillingPublishDay(params.publishDay);
  const bounds = periodBounds(params.year, params.month, timeZone);
  const publishAt = billingPublishAt(params.year, params.month, publishDay, timeZone);
  const monthEnded = now >= bounds.endInstant;
  const windowOpen = now >= publishAt;
  const published = params.periodStatus === "BILLED" || params.periodStatus === "REOPENED";

  const state: BillingPublicationState = published
    ? "PUBLISHED"
    : !monthEnded
      ? "LIVE"
      : !windowOpen
        ? "WAITING"
        : "READY";

  return { state, publishDay, publishAt, monthEnded, windowOpen };
}

export function ordinalDay(day: number): string {
  const mod100 = day % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

export function formatBillingPublishDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(date);
}

/**
 * Current institution-wide publication day. Old values are retained as history,
 * but publication policy intentionally uses the latest active global value.
 */
export async function getBillingPublishDay(institutionId: string, client: any = db): Promise<number> {
  const definition = await client.variableDefinition.findFirst({
    where: {
      institutionId,
      key: BILLING_PUBLISH_DAY_KEY,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!definition) return DEFAULT_BILLING_PUBLISH_DAY;

  const value = await client.customVariableValue.findFirst({
    where: {
      variableDefinitionId: definition.id,
      billingPeriodKey: null,
      residentId: null,
      effectiveUntil: null,
    },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    select: { valueNumber: true, valueMinor: true },
  });

  return normalizeBillingPublishDay(value?.valueNumber ?? value?.valueMinor ?? DEFAULT_BILLING_PUBLISH_DAY);
}

/**
 * Version the global publication policy. This helper mutates only the variable
 * history; callers remain responsible for the human-facing audit event.
 */
export async function setBillingPublishDay(params: {
  institutionId: string;
  adminUserId: string;
  publishDay: number;
  client?: any;
}): Promise<{ previousDay: number; publishDay: number; definitionId: string; valueId: string }> {
  const client = params.client ?? db;
  const publishDay = normalizeBillingPublishDay(params.publishDay);
  if (publishDay !== Math.round(Number(params.publishDay))) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Billing publication day must be between ${MIN_BILLING_PUBLISH_DAY} and ${MAX_BILLING_PUBLISH_DAY}.`,
      422
    );
  }

  const previousDay = await getBillingPublishDay(params.institutionId, client);
  const definition = await client.variableDefinition.upsert({
    where: {
      institutionId_key: {
        institutionId: params.institutionId,
        key: BILLING_PUBLISH_DAY_KEY,
      },
    },
    update: {
      displayName: "Billing Publish Day",
      description: "Day of the following month when an Admin may publish the completed month's bills.",
      category: "SYSTEM",
      valueType: "COUNT",
      unit: "DAYS",
      scope: "GLOBAL",
      frequency: "CONSTANT",
      providerKey: "CONTEXT_ENGINE",
      isPinned: true,
      archivedAt: null,
    },
    create: {
      institutionId: params.institutionId,
      key: BILLING_PUBLISH_DAY_KEY,
      displayName: "Billing Publish Day",
      description: "Day of the following month when an Admin may publish the completed month's bills.",
      category: "SYSTEM",
      valueType: "COUNT",
      unit: "DAYS",
      scope: "GLOBAL",
      frequency: "CONSTANT",
      providerKey: "CONTEXT_ENGINE",
      isPinned: true,
      createdByUserId: params.adminUserId,
    },
  });

  const now = new Date();
  await client.customVariableValue.updateMany({
    where: {
      variableDefinitionId: definition.id,
      billingPeriodKey: null,
      residentId: null,
      effectiveUntil: null,
    },
    data: { effectiveUntil: now },
  });

  const value = await client.customVariableValue.create({
    data: {
      variableDefinitionId: definition.id,
      valueNumber: publishDay,
      effectiveFrom: now,
      effectiveUntil: null,
      billingPeriodKey: null,
      residentId: null,
      createdByUserId: params.adminUserId,
    },
  });

  return { previousDay, publishDay, definitionId: definition.id, valueId: value.id };
}

export async function getBillingPublicationWindowForPeriod(
  periodId: string,
  client: any = db,
  now = new Date()
): Promise<BillingPublicationWindow & { timeZone: string; period: { id: string; institutionId: string; year: number; month: number; status: string } }> {
  const period = await client.billingPeriod.findUnique({
    where: { id: periodId },
    select: { id: true, institutionId: true, year: true, month: true, status: true },
  });
  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);

  const institution = await getInstitution(period.institutionId);
  const timeZone = institution?.timezone ?? "Asia/Kolkata";
  const publishDay = await getBillingPublishDay(period.institutionId, client);
  const window = billingPublicationWindow({
    year: period.year,
    month: period.month,
    publishDay,
    timeZone,
    now,
    periodStatus: period.status,
  });

  return { ...window, timeZone, period };
}

/** Final API-boundary guard before the immutable publish transaction starts. */
export async function assertBillingPublicationWindowOpen(periodId: string): Promise<BillingPublicationWindow> {
  const info = await getBillingPublicationWindowForPeriod(periodId);
  if (!info.monthEnded) {
    throw new ApiError(
      CODES.BILLING_NOT_READY,
      "This month is still live. Billing preview keeps updating until the month ends.",
      422
    );
  }
  if (!info.windowOpen) {
    const publishDate = formatBillingPublishDate(info.publishAt, info.timeZone);
    throw new ApiError(
      CODES.BILLING_NOT_READY,
      `Billing remains a live preview until ${publishDate}. An Admin can publish bills on or after that date.`,
      422
    );
  }
  return info;
}
