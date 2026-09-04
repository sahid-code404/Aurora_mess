/**
 * INSTITUTION — resolves the active institution (+ settings) with a small
 * in-memory cache (60s TTL). Institution timezone/currency drive everything.
 */
import { db } from "@/lib/db";

export type InstitutionContext = {
  id: string;
  name: string;
  timezone: string;
  currencyCode: string;
  currencyMinorDigits: number;
  settings: {
    deficitThresholdMinor: number;
    gracePeriodDays: number;
    restrictMealsOnDeficit: boolean;
    deficitPolicyEnabled: boolean;
    billingDueDays: number;
    guestMealPriceMinor: number;
  };
};

let cache: { value: InstitutionContext | null; at: number } = { value: null, at: 0 };
const TTL = 60_000;

export async function getInstitution(institutionId?: string): Promise<InstitutionContext | null> {
  if (cache.value && Date.now() - cache.at < TTL) {
    if (!institutionId || cache.value.id === institutionId) return cache.value;
  }
  const where = institutionId ? { id: institutionId, status: "ACTIVE" } : { status: "ACTIVE" };
  const inst = await db.institution.findFirst({ where, include: { settings: true } });
  if (!inst) return null;
  const ctx: InstitutionContext = {
    id: inst.id,
    name: inst.name,
    timezone: inst.timezone,
    currencyCode: inst.currencyCode,
    currencyMinorDigits: inst.currencyMinorDigits,
    settings: {
      deficitThresholdMinor: inst.settings?.deficitThresholdMinor ?? 100000,
      gracePeriodDays: inst.settings?.gracePeriodDays ?? 7,
      restrictMealsOnDeficit: inst.settings?.restrictMealsOnDeficit ?? true,
      deficitPolicyEnabled: inst.settings?.deficitPolicyEnabled ?? true,
      billingDueDays: inst.settings?.billingDueDays ?? 10,
      guestMealPriceMinor: inst.settings?.guestMealPriceMinor ?? 5500,
    },
  };
  cache = { value: ctx, at: Date.now() };
  return ctx;
}

/** Reset cache when settings change. */
export function invalidateInstitutionCache(): void {
  cache = { value: null, at: 0 };
}
