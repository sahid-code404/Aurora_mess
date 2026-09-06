/**
 * MEAL DEFINITION schemas (zod) — shared by POST + PUT admin routes.
 * Cross-field invariants live in validateDefinitionInvariants so the PUT
 * route can validate the MERGED config (partial patch on existing state).
 */
import { z } from "zod";
import { dateKeySchema } from "@/lib/validation";
import { parseDecimalToMinor } from "@/lib/money";

export const hhmmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use the HH:MM 24-hour format (e.g. 09:00).");

export const colorTokenSchema = z.enum(["emerald", "amber", "rose", "sky", "slate", "teal"]);

export const mealDefinitionCreateSchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters.").max(60),
  description: z.string().trim().max(500).optional(),
  icon: z.string().trim().min(1).max(60).optional(),
  colorToken: colorTokenSchema.optional(),
  mealType: z.enum(["REGULAR", "SPECIAL", "GUEST_ONLY", "FESTIVAL", "CUSTOM"]),
  defaultState: z.enum(["ON", "OFF"]),
  defaultVisible: z.boolean().default(true),
  pricingStrategy: z.enum(["FORMULA", "FIXED"]),
  fixedPriceMinor: z.string().trim().min(1).optional(),
  scheduleStrategy: z.enum(["DAILY", "WEEKDAYS", "ONE_TIME"]),
  weekdaysCsv: z.string().trim().optional(),
  specificDate: dateKeySchema.optional(),
  serviceStartLocal: hhmmSchema,
  serviceEndLocal: hhmmSchema,
  cutoffStrategy: z.enum(["SAME_DAY", "PREVIOUS_DAY", "CUSTOM_OFFSET"]),
  cutoffOffsetDays: z.coerce.number().int().min(0).max(30).optional(),
  cutoffLocalTime: hhmmSchema,
  internalNotes: z.string().trim().max(1000).optional(),
});

export const mealDefinitionUpdateSchema = mealDefinitionCreateSchema.partial();

export type MealDefinitionConfig = z.infer<typeof mealDefinitionCreateSchema>;

/** Valid weekdays CSV: "1,2,3,4,5" (Mon=1..Sun=7). */
export function validWeekdaysCsv(csv: string | null | undefined): boolean {
  if (!csv) return false;
  const parts = csv.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.length > 7) return false;
  const seen = new Set<number>();
  for (const p of parts) {
    if (!/^[1-7]$/.test(p)) return false;
    const n = Number(p);
    if (seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}

/**
 * Validate the MERGED full config (cross-field invariants).
 * Money strings (fixedPriceMinor) are parsed here too — invalid decimal →
 * field error (parseDecimalToMinor null contract).
 */
export function validateDefinitionInvariants(cfg: {
  name?: unknown;
  pricingStrategy?: string;
  fixedPriceMinor?: string | null;
  scheduleStrategy?: string;
  weekdaysCsv?: string | null;
  specificDate?: string | null;
  serviceStartLocal?: string;
  serviceEndLocal?: string;
  cutoffStrategy?: string;
  cutoffOffsetDays?: number | null;
  cutoffLocalTime?: string;
}): { fields: Record<string, string>; fixedPriceMinorParsed: number | null } {
  const fields: Record<string, string> = {};
  let fixedPriceMinorParsed: number | null = null;

  if (cfg.pricingStrategy === "FIXED") {
    if (!cfg.fixedPriceMinor || cfg.fixedPriceMinor.trim() === "") {
      fields.fixedPriceMinor = "A fixed price is required for FIXED pricing.";
    } else {
      const minor = parseDecimalToMinor(cfg.fixedPriceMinor);
      if (minor == null || minor <= 0) {
        fields.fixedPriceMinor = "Enter a valid price like 55.00.";
      } else {
        fixedPriceMinorParsed = minor;
      }
    }
  }

  if (cfg.scheduleStrategy === "WEEKDAYS" && !validWeekdaysCsv(cfg.weekdaysCsv ?? undefined)) {
    fields.weekdaysCsv = 'Pick at least one weekday, e.g. "1,2,3,4,5".';
  }
  if (cfg.scheduleStrategy === "ONE_TIME" && !cfg.specificDate) {
    fields.specificDate = "A specific date is required for one-time meals.";
  }
  if (cfg.scheduleStrategy === "DAILY" && (cfg.weekdaysCsv || cfg.specificDate)) {
    // allowed but ignored — no error (lenient), keeps config clean on write
  }

  if (cfg.serviceStartLocal && cfg.serviceEndLocal && cfg.serviceStartLocal >= cfg.serviceEndLocal) {
    fields.serviceEndLocal = "Service end must be after service start.";
  }

  if (cfg.cutoffStrategy === "CUSTOM_OFFSET" && (cfg.cutoffOffsetDays == null || cfg.cutoffOffsetDays < 0)) {
    fields.cutoffOffsetDays = "Enter the cutoff offset in days (0-30).";
  }

  const sameDayCutoff =
    cfg.cutoffStrategy === "SAME_DAY" ||
    (cfg.cutoffStrategy === "CUSTOM_OFFSET" && (cfg.cutoffOffsetDays ?? 0) === 0);
  if (
    sameDayCutoff &&
    cfg.cutoffLocalTime &&
    cfg.serviceStartLocal &&
    cfg.cutoffLocalTime > cfg.serviceStartLocal
  ) {
    fields.cutoffLocalTime = "Same-day cutoff cannot be after service starts.";
  }

  return { fields, fixedPriceMinorParsed };
}
