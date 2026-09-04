import { cn } from "@/lib/utils";

/**
 * Money — renders integer minor units (paise) as ₹1,23,456.78 (en-IN).
 * CLIENT-SAFE standalone duplicate of lib/money.ts formatMinor (no server
 * imports in client bundles); the lib remains the single source of truth
 * for authoritative math. Keep this tiny and in sync.
 *
 * Every rendered amount is wrapped in `.kpi-num` (tabular lining figures
 * + tight tracking) so columns of money align — do not remove it.
 */

const MINOR_DIGITS = 2;
const MINOR_FACTOR = 10 ** MINOR_DIGITS;

function formatMinorLocal(minor: number, opts?: { withSign?: boolean }): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_FACTOR);
  const frac = String(abs % MINOR_FACTOR).padStart(MINOR_DIGITS, "0");
  const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(whole);
  const sign = neg ? "−" : opts?.withSign ? "+" : "";
  return `${sign}₹${grouped}.${frac}`;
}

export interface MoneyProps {
  /** Integer minor units (paise). */
  minor: number;
  /** Prefix "+" for positive values (deltas). Negative always shows "−". */
  withSign?: boolean;
  /** Omit the ₹ symbol (compact sublabels). */
  plain?: boolean;
  className?: string;
}

export function Money({ minor, withSign, plain, className }: MoneyProps) {
  let text = formatMinorLocal(minor, { withSign });
  if (plain) text = text.replace("₹", "").replace("−", "-");
  return <span className={cn("kpi-num", className)}>{text}</span>;
}

export default Money;
