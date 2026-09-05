from pathlib import Path


def replace_once(path: str, old: str, new: str) -> bool:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return False
    if old not in text:
        raise SystemExit(f"expected pattern missing in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))
    return True


changed = False
schema_path = Path("prisma/schema.prisma")
schema = schema_path.read_text()
if "model RateLimitBucket" not in schema:
    marker = "\n// ---------------------------------------------------------------------\n// Meals: definitions → versions → instances → resident meals\n"
    if marker not in schema:
        raise SystemExit("meal section marker not found in prisma/schema.prisma")
    model = '''\n// ---------------------------------------------------------------------\n// Shared abuse-protection counters (opaque SHA-256 keys only)\n// ---------------------------------------------------------------------\n\nmodel RateLimitBucket {\n  keyHash   String   @id @db.Char(64)\n  count     Int\n  resetAt   DateTime\n  updatedAt DateTime @default(now()) @updatedAt\n\n  @@index([resetAt])\n}\n'''
    schema_path.write_text(schema.replace(marker, model + marker, 1))
    changed = True

for path, old, new in [
    ("src/app/api/v1/auth/register/route.ts", "const limit = rateLimit(", "const limit = await rateLimit("),
    ("src/app/api/v1/admin/announcements/route.ts", "const rl = rateLimit(", "const rl = await rateLimit("),
    ("src/app/api/v1/admin/ai/proof-preview/route.ts", "const rl = rateLimit(", "const rl = await rateLimit("),
    ("src/app/api/v1/payments/route.ts", "const rl = rateLimit(", "const rl = await rateLimit("),
    ("src/app/api/v1/admin/formulas/preview/route.ts", "const rl = rateLimit(", "const rl = await rateLimit("),
]:
    changed = replace_once(path, old, new) or changed

if not changed:
    print("Phase 14 shared-rate-limit patch already applied")
else:
    print("Phase 14 shared-rate-limit patch applied")
