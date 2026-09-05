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
const HASH_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/i;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, PARAMS);
  return `scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

type ParsedHash = {
  salt: Buffer;
  expected: Buffer;
  params: { N: number; r: number; p: number };
};

function parseStoredHash(stored: string): ParsedHash | null {
  const match = HASH_RE.exec(stored);
  if (!match) return null;

  const [, nRaw, rRaw, pRaw, saltHex, keyHex] = match;
  if (saltHex.length % 2 !== 0 || keyHex.length % 2 !== 0) return null;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N < 2 ||
    !Number.isInteger(Math.log2(N)) ||
    r < 1 ||
    p < 1 ||
    N > 1_048_576 ||
    r > 64 ||
    p > 64
  ) {
    return null;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  if (salt.length < 16 || expected.length < 32 || expected.length > 128) return null;

  return { salt, expected, params: { N, r, p } };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;

  // Deliberately do not swallow KDF/runtime failures here. A malformed stored
  // hash is an authentication mismatch, but a crypto runtime failure is an
  // operational error and must never be misreported as "wrong password".
  const key = await scrypt(password, parsed.salt, parsed.expected.length, parsed.params);
  return key.length === parsed.expected.length && timingSafeEqual(key, parsed.expected);
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
