/**
 * SHARED VALIDATION — zod schemas reused by routes and (conceptually) forms.
 * Server always validates independently of the client (spec §162).
 */
import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(180);

export const passwordSchema = z
  .string()
  .min(10, "Password needs at least 10 characters.")
  .max(128)
  .regex(/[a-z]/, "Password needs a lowercase letter.")
  .regex(/[A-Z]/, "Password needs an uppercase letter.")
  .regex(/[0-9]/, "Password needs a number.");

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the full name.")
  .max(90);

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+0-9 ()-]{6,18}$/, "Enter a valid phone number.")
  .optional()
  .or(z.literal(""));

export const roomSchema = z.string().trim().max(20).optional().or(z.literal(""));

export const moneyInputSchema = z
  .string()
  .min(1, "Enter an amount.");

export const reasonSchema = z
  .string()
  .trim()
  .min(3, "A short reason is required.")
  .max(500, "Keep the reason under 500 characters.");

export const paymentMethodSchema = z.enum(["UPI", "CASH", "BANK_TRANSFER", "OTHER"]);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const dateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates use the YYYY-MM-DD format.")
  .refine((key) => {
    // Calendar validity: "2026-02-30" would otherwise silently roll over to
    // March 2nd downstream (audit 9-b finding #10).
    const [y, m, d] = key.split("-").map(Number);
    if (m < 1 || m > 12) return false;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of month m = its last day
    return d >= 1 && d <= daysInMonth;
  }, "That date doesn't exist on the calendar.");

export function parseMoneyToMinor(value: string): number {
  const cleaned = String(value ?? "").replace(/[₹,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return Number.NaN;
  }
  const [int, frac = ""] = cleaned.split(".");
  return Number(int) * 100 + Number(frac.padEnd(2, "0"));
}
