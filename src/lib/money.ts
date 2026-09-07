/**
 * MONEY — the ONLY place financial rounding/formatting happens (spec §17-18).
 * All authoritative amounts are integer minor units (paise). Never floats.
 */

export const MINOR_DIGITS = 2;
export const MINOR_FACTOR = 10 ** MINOR_DIGITS; // 100

const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_TWO = BigInt(2);
const BIG_TEN = BigInt(10);

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

/** Convert a finite JS number's canonical decimal representation to an exact rational. */
function decimalNumberRatio(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value)) throw new Error("NON_FINITE_MULTIPLIER");
  if (value === 0) return { numerator: BIG_ZERO, denominator: BIG_ONE };

  const negative = value < 0;
  const raw = Math.abs(value).toString().toLowerCase();
  const [mantissa, exponentRaw] = raw.split("e");
  const exponent = exponentRaw ? Number(exponentRaw) : 0;
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const digitsText = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  let numerator = BigInt(digitsText);
  let scale = fraction.length - exponent;

  if (scale < 0) {
    numerator *= BIG_TEN ** BigInt(-scale);
    scale = 0;
  }

  return {
    numerator: negative ? -numerator : numerator,
    denominator: BIG_TEN ** BigInt(scale),
  };
}

/**
 * Multiply a decimal quantity (e.g. 1.005 kg) by a minor-unit price using
 * decimal/BigInt arithmetic, then round HALF-UP to one minor unit.
 *
 * This intentionally avoids `quantity * unitPriceMinor` floating-point money
 * arithmetic while remaining backward-compatible with integer formula/count
 * multiplication through the same helper.
 */
export function multiplyRoundHalfUp(quantity: number, unitPriceMinor: number): number {
  if (!Number.isSafeInteger(unitPriceMinor)) throw new Error("UNSAFE_MINOR_AMOUNT");

  const ratio = decimalNumberRatio(quantity);
  const signedProduct = ratio.numerator * BigInt(unitPriceMinor);
  const negative = signedProduct < BIG_ZERO;
  const absProduct = negative ? -signedProduct : signedProduct;
  const quotient = absProduct / ratio.denominator;
  const remainder = absProduct % ratio.denominator;
  const roundedAbs = remainder * BIG_TWO >= ratio.denominator ? quotient + BIG_ONE : quotient;
  const rounded = negative ? -roundedAbs : roundedAbs;

  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new Error("UNSAFE_MINOR_RESULT");
  return result;
}

/** Clamp helper used by deficit/policy math. */
export function clampMinor(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
