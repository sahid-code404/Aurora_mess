/**
 * PASSWORD — scrypt (memory-hard) with stored parameters (spec §11).
 * Adaptation documented in worklog: Argon2id preferred in production; scrypt
 * chosen here for a dependency-free, memory-hard KDF with timing-safe compare.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, PARAMS);
  return `scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, params, saltHex, keyHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const p = Object.fromEntries(params.split(",").map((kv) => kv.split("=") as [string, string]));
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    const key = await scrypt(password, salt, expected.length, {
      N: Number(p.N),
      r: Number(p.r),
      p: Number(p.p),
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Password policy: 10+ chars, mixed case + digit (friendly, not punishing). */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push("at least 10 characters");
  if (!/[a-z]/.test(password)) problems.push("a lowercase letter");
  if (!/[A-Z]/.test(password)) problems.push("an uppercase letter");
  if (!/[0-9]/.test(password)) problems.push("a number");
  return problems;
}
