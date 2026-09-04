/**
 * PERIOD VARIABLES (spec §46, §50-51)
 *
 * Resolves all variables for a given billing period context by orchestrating
 * the central variable registry and domain providers.
 */
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { addDaysToKey, localDateMidnightUtc, monthBoundsInTz, zonedTimeToUtc } from "@/lib/time";
import { gatherAllVariables } from "./registry";

export interface PeriodBounds {
  year: number;
  month: number;
  key: string;
  periodKey: string;
  startKey: string;
  endKey: string;
  startAt: Date;
  endExclusiveAt: Date;
  startInstant: Date;
  endInstant: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function periodBounds(year: number, month: number, tz = "UTC"): PeriodBounds {
  const periodKey = `${year}-${pad2(month)}`;
  const startKey = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0));
  const endKey = `${lastDay.getUTCFullYear()}-${pad2(lastDay.getUTCMonth() + 1)}-${pad2(lastDay.getUTCDate())}`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    year,
    month,
    key: periodKey,
    periodKey,
    startKey,
    endKey,
    startAt: localDateMidnightUtc(startKey),
    endExclusiveAt: localDateMidnightUtc(addDaysToKey(endKey, 1)),
    startInstant: zonedTimeToUtc(year, month, 1, 0, 0, tz),
    endInstant: zonedTimeToUtc(nextYear, nextMonth, 1, 0, 0, tz),
  };
}

export function currentPeriodBounds(tz: string): PeriodBounds {
  const b = monthBoundsInTz(new Date(), tz);
  return periodBounds(b.year, b.month, tz);
}

/**
 * Resolve all registry variables (system, custom, and derived) for a period.
 * Fully backward-compatible with legacy callers (billing.ts, dashboard, etc.).
 */
export async function gatherPeriodVariables(
  institutionId: string,
  year: number,
  month: number,
  residentId?: string,
  client: any = db
): Promise<Record<string, number>> {
  const registry = await gatherAllVariables(institutionId, year, month, residentId, client);
  return registry.valuesMap;
}
