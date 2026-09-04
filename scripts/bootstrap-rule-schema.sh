#!/usr/bin/env bash
set -euo pipefail

if grep -q '^model RuleDefinition {' prisma/schema.prisma; then
  echo "Versioned Rule schema already present; nothing to generate."
  exit 0
fi

python3 - <<'PY'
from pathlib import Path
path = Path('prisma/schema.prisma')
text = path.read_text()
marker = '// ---------------------------------------------------------------------\n// Formula engine (versioned, safe AST, DAG dependencies)\n// ---------------------------------------------------------------------\n'
block = '''// ---------------------------------------------------------------------
// Minimal Rule Engine — versioned deterministic policy rule sets
// ---------------------------------------------------------------------

model RuleDefinition {
  id            String   @id @default(cuid())
  institutionId String
  key           String
  name          String
  description   String?
  policyType    String
  status        String   @default("ACTIVE") // ACTIVE | ARCHIVED
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  versions RuleVersion[]

  @@unique([institutionId, key])
  @@index([institutionId, policyType, status])
}

model RuleVersion {
  id               String    @id @default(cuid())
  ruleDefinitionId String
  version          Int
  rulesJson        String // validated StructuredDecisionRule[] JSON; never executable code
  checksum         String
  effectiveFrom    DateTime?
  effectiveUntil   DateTime?
  status           String    @default("DRAFT") // DRAFT | ACTIVE | SCHEDULED | HISTORICAL
  createdByUserId  String?
  reason           String?
  createdAt        DateTime  @default(now())

  definition RuleDefinition @relation(fields: [ruleDefinitionId], references: [id], onDelete: Cascade)

  @@unique([ruleDefinitionId, version])
  @@index([ruleDefinitionId, status, effectiveFrom])
}

'''
if marker not in text:
    raise SystemExit('Formula-engine schema marker not found')
path.write_text(text.replace(marker, block + marker, 1))
PY

bunx prisma format
bunx prisma validate
bunx prisma migrate deploy

migration_dir="prisma/migrations/20260905_010000_add_rule_engine"
mkdir -p "$migration_dir"
bunx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$migration_dir/migration.sql"
test -s "$migration_dir/migration.sql"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add prisma/schema.prisma "$migration_dir/migration.sql"
git commit -m "infra: add versioned Rule models and migration [rule-schema-generated]"
git push origin HEAD:feat/versioned-rule-persistence
