import { randomBytes, scrypt as nativeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;
const promisified = promisify(nativeScrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

function callbackScrypt(password: string, salt: Buffer, keylen: number, options: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nativeScrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function run(label: string, derive: typeof promisified) {
  const password = "Resident#12345";
  let mismatches = 0;
  for (let i = 0; i < 32; i++) {
    const salt = randomBytes(16);
    const expected = await derive(password, salt, KEYLEN, PARAMS);
    for (let j = 0; j < 8; j++) {
      const actual = await derive(password, salt, KEYLEN, PARAMS);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        mismatches++;
        console.error(`${label} mismatch at sample ${i}, repeat ${j}`);
      }
    }
  }
  console.log(`${label}: mismatches=${mismatches}`);
  return mismatches;
}

const promisifiedFailures = await run("promisified", promisified);
const callbackFailures = await run("callback", callbackScrypt);

if (promisifiedFailures || callbackFailures) process.exit(1);
