import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../../src/lib/auth/password";

describe("password hashing", () => {
  test("generated scrypt hashes verify repeatedly and reject the wrong password", async () => {
    const password = "Resident#12345";
    const stored = await hashPassword(password);

    for (let i = 0; i < 8; i++) {
      expect(await verifyPassword(password, stored)).toBe(true);
    }
    expect(await verifyPassword("Resident#12346", stored)).toBe(false);
  });

  test("malformed stored hashes fail closed without being treated as valid", async () => {
    const malformed = [
      "",
      "not-scrypt",
      "scrypt$N=16384,r=8,p=1$zz$00",
      "scrypt$N=3,r=8,p=1$00112233445566778899aabbccddeeff$" + "00".repeat(64),
      "scrypt$N=16384,r=0,p=1$00112233445566778899aabbccddeeff$" + "00".repeat(64),
    ];

    for (const stored of malformed) {
      expect(await verifyPassword("Resident#12345", stored)).toBe(false);
    }
  });
});
