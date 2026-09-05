from pathlib import Path

path = Path("scripts/seed.ts")
text = path.read_text()

old = '''  // ---------------------------------------------------------------- users
  // Generate and verify the two deterministic development credential hashes once.
  // Reusing a role hash keeps the seed fast and guarantees every documented
  // Resident test account authenticates with the same advertised password.
  const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
  const residentPasswordHash = await hashPassword(RESIDENT_PASSWORD);
  if (!(await verifyPassword(ADMIN_PASSWORD, adminPasswordHash))) {
    throw new Error("Development Admin credential hash self-check failed.");
  }
  if (!(await verifyPassword(RESIDENT_PASSWORD, residentPasswordHash))) {
    throw new Error("Development Resident credential hash self-check failed.");
  }

  const mkUser = async (email: string, role: string, status: string, fullName: string, room: string, from?: Date) => {
    const u = await db.user.create({
      data: {
        institutionId: inst.id,
        role,
        status,
        email,
        passwordHash: role === "ADMIN" ? adminPasswordHash : residentPasswordHash,
        membershipEffectiveFrom: from ?? new Date(Date.UTC(prev.year, prev.month - 1, 1)),
      },
    });'''

new = '''  // ---------------------------------------------------------------- users
  const mkUser = async (email: string, role: string, status: string, fullName: string, room: string, from?: Date) => {
    const password = role === "ADMIN" ? ADMIN_PASSWORD : RESIDENT_PASSWORD;
    // Keep a unique salt/hash per user even in development fixtures. Verify the
    // generated value before persistence, then verify Prisma's returned value so
    // seed failures identify the exact boundary that changed credential bytes.
    const passwordHash = await hashPassword(password);
    if (!(await verifyPassword(password, passwordHash))) {
      throw new Error(`Generated development credential verification failed for ${email}.`);
    }

    const u = await db.user.create({
      data: {
        institutionId: inst.id,
        role,
        status,
        email,
        passwordHash,
        membershipEffectiveFrom: from ?? new Date(Date.UTC(prev.year, prev.month - 1, 1)),
      },
    });
    if (u.passwordHash !== passwordHash) {
      throw new Error(`Credential hash changed during insert for ${email}.`);
    }
    if (!(await verifyPassword(password, u.passwordHash))) {
      throw new Error(`Inserted development credential verification failed for ${email}.`);
    }'''

if new not in text:
    if old not in text:
        raise SystemExit("expected users block not found")
    text = text.replace(old, new, 1)

old2 = '''  // Fail the seed before creating dependent fixture data if the documented
  // credentials do not verify against what PostgreSQL actually persisted.
  const persistedAdmin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { passwordHash: true } });
  const persistedResident = await db.user.findUnique({ where: { email: "sahid@messtest.in" }, select: { passwordHash: true } });
  if (!persistedAdmin || !(await verifyPassword(ADMIN_PASSWORD, persistedAdmin.passwordHash))) {
    throw new Error("Persisted development Admin credential verification failed.");
  }
  if (!persistedResident || !(await verifyPassword(RESIDENT_PASSWORD, persistedResident.passwordHash))) {
    throw new Error("Persisted development Resident credential verification failed.");
  }'''

new2 = '''  // Re-read the two documented test accounts from PostgreSQL. Exact string
  // equality distinguishes a storage/lookup defect from a KDF/runtime defect.
  const persistedAdmin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { passwordHash: true } });
  const persistedResident = await db.user.findUnique({ where: { email: "sahid@messtest.in" }, select: { passwordHash: true } });
  if (!persistedAdmin || persistedAdmin.passwordHash !== admin.passwordHash) {
    throw new Error("Persisted development Admin credential hash round-trip mismatch.");
  }
  if (!persistedResident || persistedResident.passwordHash !== residents[0].passwordHash) {
    throw new Error("Persisted development Resident credential hash round-trip mismatch.");
  }
  if (!(await verifyPassword(ADMIN_PASSWORD, persistedAdmin.passwordHash))) {
    throw new Error("Persisted development Admin credential verification failed.");
  }
  if (!(await verifyPassword(RESIDENT_PASSWORD, persistedResident.passwordHash))) {
    throw new Error("Persisted development Resident credential verification failed.");
  }'''

if new2 not in text:
    if old2 not in text:
        raise SystemExit("expected persisted credential block not found")
    text = text.replace(old2, new2, 1)

path.write_text(text)
print("Phase 17 seed credential round-trip patch applied")
