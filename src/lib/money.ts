/**
 * MONEY — the ONLY place financial rounding/formatting happens (spec §17-18).
 * All authoritative amounts are integer minor units (paise). Never floats.
 */

export const MINOR_DIGITS = 2;
export const MINOR_FACTOR = 10 ** MINOR_DIGITS; // 100

/** Parse a user-entered decimal string ("1234.56", "1,234.56", "₹1234") → minor units. */
export function parseDecimalToMinor(input: string): number | null {
  const cleaned = String(input ?? "")
    .replace(/[₹,\s]/g, "")
    .trim();
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === "" || cleaned === "-" || cleaned === ".")
    return null;
  const neg = cleaned.startsWith("-");
  const body = neg ? cleaned.slice(1) : cleaned;
  const [intPart = "0", fracPart = ""] = body.split(".");
  if (fracPart.length > MINOR_DIGITS) return null; // reject excess precision instead of silently rounding input
  const int = intPart === "" ? 0 : Number(intPart);
  const frac = fracPart === "" ? 0 : Number(fracPart.padEnd(MINOR_DIGITS, "0"));
  const minor = int * MINOR_FACTOR + frac;
  if (!Number.isSafeInteger(minor)) return null;
  return neg ? -minor : minor;
}

/** Format minor units as ₹1,23,456.78 (en-IN grouping). */
export function formatMinor(minor: number, opts?: { withSign?: boolean }): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_FACTOR);
  const frac = String(abs % MINOR_FACTOR).padStart(MINOR_DIGITS, "0");
  const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(whole);
  const sign = neg ? "−" : opts?.withSign ? "+" : "";
  return `${sign}₹${grouped}.${frac}`;
}

/** Format minor units without symbol (for compact KPI sublabels). */
export function formatMinorPlain(minor: number): string {
  return formatMinor(minor).replace("₹", "").replace("−", "-");
}

/**
 * Divide minor units by a count, rounding HALF-UP at minor-unit precision.
 * Used by the formula evaluator for per-meal charges. Division by zero
 * must be caught by the caller (FORMULA_DIVIDE_BY_ZERO).
 */
export function divideMinorRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error("DIVIDE_BY_ZERO");
  const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
  // Work in tenths-of-a-minor-unit so half-up rounding is exact integer math:
  // q = floor(|num|·10 / |den|) → base = floor(q/10) minor units, and the
  // final digit of q decides the half-up bump of ONE minor unit.
  const num = Math.abs(numerator) * 10;
  const den = Math.abs(denominator);
  const q = Math.floor(num / den);
  const base = Math.floor(q / 10);
  const remainderDigit = q % 10;
  const rounded = remainderDigit >= 5 ? base + 1 : base;
  return sign * rounded;
}

/** Multiply a quantity (e.g. 1.5 kg) by a minor-unit price, rounded half-up. */
export function multiplyRoundHalfUp(quantity: number, unitPriceMinor: number): number {
  const product = quantity * unitPriceMinor;
  return product >= 0 ? Math.round(product) : -Math.round(-product);
}

/** Clamp helper used by deficit/policy math. */
export function clampMinor(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
