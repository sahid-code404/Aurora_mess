from pathlib import Path

path = Path("scripts/seed.ts")
text = path.read_text()

replacements = [
    (
        'import { hashPassword } from "../src/lib/auth/password";',
        'import { hashPassword, verifyPassword } from "../src/lib/auth/password";',
    ),
    (
        '  // ---------------------------------------------------------------- users\n  const mkUser = async (email: string, role: string, status: string, fullName: string, room: string, from?: Date) => {',
        '''  // ---------------------------------------------------------------- users\n  // Generate and verify the two deterministic development credential hashes once.\n  // Reusing a role hash keeps the seed fast and guarantees every documented\n  // Resident test account authenticates with the same advertised password.\n  const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);\n  const residentPasswordHash = await hashPassword(RESIDENT_PASSWORD);\n  if (!(await verifyPassword(ADMIN_PASSWORD, adminPasswordHash))) {\n    throw new Error("Development Admin credential hash self-check failed.");\n  }\n  if (!(await verifyPassword(RESIDENT_PASSWORD, residentPasswordHash))) {\n    throw new Error("Development Resident credential hash self-check failed.");\n  }\n\n  const mkUser = async (email: string, role: string, status: string, fullName: string, room: string, from?: Date) => {''',
    ),
    (
        '        passwordHash: await hashPassword(role === "ADMIN" ? ADMIN_PASSWORD : RESIDENT_PASSWORD),',
        '        passwordHash: role === "ADMIN" ? adminPasswordHash : residentPasswordHash,',
    ),
    (
        '''  const pendingResident = await mkUser("newres@messtest.in", "RESIDENT", "PENDING_APPROVAL", "Nikhil Verma", "B-210");\n  for (const r of residents) {''',
        '''  const pendingResident = await mkUser("newres@messtest.in", "RESIDENT", "PENDING_APPROVAL", "Nikhil Verma", "B-210");\n\n  // Fail the seed before creating dependent fixture data if the documented\n  // credentials do not verify against what PostgreSQL actually persisted.\n  const persistedAdmin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { passwordHash: true } });\n  const persistedResident = await db.user.findUnique({ where: { email: "sahid@messtest.in" }, select: { passwordHash: true } });\n  if (!persistedAdmin || !(await verifyPassword(ADMIN_PASSWORD, persistedAdmin.passwordHash))) {\n    throw new Error("Persisted development Admin credential verification failed.");\n  }\n  if (!persistedResident || !(await verifyPassword(RESIDENT_PASSWORD, persistedResident.passwordHash))) {\n    throw new Error("Persisted development Resident credential verification failed.");\n  }\n\n  for (const r of residents) {''',
    ),
]

changed = False
for old, new in replacements:
    if new in text:
        continue
    if old not in text:
        raise SystemExit(f"expected pattern missing: {old[:100]!r}")
    text = text.replace(old, new, 1)
    changed = True

if changed:
    path.write_text(text)
    print("Phase 17 seed credential patch applied")
else:
    print("Phase 17 seed credential patch already applied")
