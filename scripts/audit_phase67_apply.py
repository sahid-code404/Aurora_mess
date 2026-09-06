from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f"{path}: expected exactly one replacement, found {s.count(old)} for {old[:80]!r}")
    p.write_text(s.replace(old, new, 1))

# FormulaDefinition has no supported archive transition. FormulaVersion effective
# windows are the real history lifecycle.
replace_once(
    "prisma/schema.prisma",
    '''  scope             String    @default("BILLING_PERIOD") // GLOBAL | BILLING_PERIOD | RESIDENT | MEAL\n  status            String    @default("ACTIVE") // ACTIVE | ARCHIVED\n  activeVersionId   String?\n  archivedAt        DateTime?\n  createdAt         DateTime  @default(now())''',
    '''  scope             String    @default("BILLING_PERIOD") // GLOBAL | BILLING_PERIOD | RESIDENT | MEAL\n  activeVersionId   String?\n  createdAt         DateTime  @default(now())''',
)

# FormulaDefinition readers/writers no longer filter or write dead archive state.
replace_once(
    "src/lib/domain/formula/versions.ts",
    'where: { institutionId, outputVariableKey, archivedAt: null },',
    'where: { institutionId, outputVariableKey },',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    '''        scope: "BILLING_PERIOD",\n        status: "ACTIVE",''',
    '''        scope: "BILLING_PERIOD",''',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    'where: { institutionId: input.institutionId, status: "ACTIVE", archivedAt: null },',
    'where: { institutionId: input.institutionId },',
)
replace_once(
    "src/lib/domain/formula/registry.ts",
    'where: { institutionId, status: "ACTIVE", archivedAt: null },',
    'where: { institutionId },',
)
replace_once(
    "src/app/api/v1/admin/formulas/preview/route.ts",
    'where: { institutionId: ctx.institutionId, status: "ACTIVE", archivedAt: null },',
    'where: { institutionId: ctx.institutionId },',
)
replace_once(
    "src/app/api/v1/admin/formulas/route.ts",
    'where: { institutionId: ctx.institutionId, archivedAt: null },',
    'where: { institutionId: ctx.institutionId },',
)
replace_once(
    "src/app/api/v1/admin/formulas/route.ts",
    '''        scope: d.scope,\n        status: d.status,\n        activeVersion:''',
    '''        scope: d.scope,\n        activeVersion:''',
)
replace_once(
    "src/app/api/v1/admin/formulas/route.ts",
    'where: { institutionId: ctx.institutionId, outputVariableKey: key, archivedAt: null },',
    'where: { institutionId: ctx.institutionId, outputVariableKey: key },',
)
replace_once(
    "src/app/api/v1/admin/formulas/route.ts",
    '''      description: body.description?.trim() ?? null,\n      scope: body.scope,\n      status: "ACTIVE",''',
    '''      description: body.description?.trim() ?? null,\n      scope: body.scope,''',
)

# Custom-variable values are billing inputs. Serialize them with billing and
# perform the frozen-period decision only after the Institution mutex.
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    'import { localDateMidnightUtc } from "@/lib/time";\n',
    'import { localDateMidnightUtc } from "@/lib/time";\nimport { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";\nimport { assertFormulaInputPeriodMutable } from "./period-mutation";\n',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''  return await db.$transaction(async (tx) => {\n    const def = await tx.variableDefinition.create({''',
    '''  return await db.$transaction(async (tx) => {\n    await lockInstitutionFinancialMutation(tx, input.institutionId);\n    if (input.effectivePeriod) {\n      const match = /^(\\d{4})-(\\d{2})$/.exec(input.effectivePeriod);\n      if (!match) throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 400);\n      await assertFormulaInputPeriodMutable(tx, input.institutionId, Number(match[1]), Number(match[2]));\n    }\n\n    const def = await tx.variableDefinition.create({''',
)

p = Path("src/lib/domain/formula/custom-variables.ts")
s = p.read_text()
start = s.index("export async function setCustomVariableValue(")
end = s.index("\nexport async function archiveCustomVariable(", start)
new_fn = '''export async function setCustomVariableValue(input: {\n  institutionId: string;\n  adminUserId: string;\n  variableDefinitionId: string;\n  billingPeriodKey: string; // "YYYY-MM"\n  value: number;\n}) {\n  const match = /^(\\d{4})-(\\d{2})$/.exec(input.billingPeriodKey);\n  if (!match) {\n    throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 400);\n  }\n  const year = Number(match[1]);\n  const month = Number(match[2]);\n  if (month < 1 || month > 12) {\n    throw new ApiError(CODES.VALIDATION_FAILED, "Period month must be between 01 and 12.", 400);\n  }\n  const periodStart = localDateMidnightUtc(`${input.billingPeriodKey}-01`);\n\n  return await db.$transaction(async (tx) => {\n    await lockInstitutionFinancialMutation(tx, input.institutionId);\n    await assertFormulaInputPeriodMutable(tx, input.institutionId, year, month);\n\n    const def = await tx.variableDefinition.findFirst({\n      where: { id: input.variableDefinitionId, institutionId: input.institutionId, archivedAt: null },\n    });\n    if (!def) {\n      throw new ApiError(CODES.NOT_FOUND, "Custom variable not found.", 404);\n    }\n\n    const isMoney = def.valueType === "MONEY";\n    const existingVal = await tx.customVariableValue.findFirst({\n      where: {\n        variableDefinitionId: def.id,\n        billingPeriodKey: input.billingPeriodKey,\n      },\n    });\n\n    const valRow = existingVal\n      ? await tx.customVariableValue.update({\n          where: { id: existingVal.id },\n          data: {\n            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney ? input.value : null,\n            createdByUserId: input.adminUserId,\n            updatedAt: new Date(),\n          },\n        })\n      : await tx.customVariableValue.create({\n          data: {\n            variableDefinitionId: def.id,\n            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney ? input.value : null,\n            effectiveFrom: periodStart,\n            billingPeriodKey: input.billingPeriodKey,\n            createdByUserId: input.adminUserId,\n          },\n        });\n\n    await appendAudit(\n      {\n        institutionId: input.institutionId,\n        actorUserId: input.adminUserId,\n        actorRole: "ADMIN",\n        action: "CUSTOM_VARIABLE_VALUE_UPDATED",\n        entityType: "VARIABLE_DEFINITION",\n        entityId: def.id,\n        requestId: `var-val-${def.id}`,\n        beforeSummary: existingVal ? `Value was ${existingVal.valueMinor ?? existingVal.valueNumber}` : "Not set",\n        afterSummary: `Period ${input.billingPeriodKey} set to ${input.value}`,\n        metadata: { key: def.key, period: input.billingPeriodKey, value: input.value },\n      },\n      tx\n    );\n\n    return valRow;\n  });\n}\n'''
p.write_text(s[:start] + new_fn + s[end:])

# A variable used by any saved formula version is historical formula input and
# cannot be globally archived without rewriting delayed historical evaluation.
p = Path("src/lib/domain/formula/custom-variables.ts")
s = p.read_text()
old = '''  // Check if any active formula depends on this variable key (spec §65, §67)\n  const activeFormulas = await db.formulaDefinition.findMany({\n    where: { institutionId: input.institutionId, status: "ACTIVE", archivedAt: null },\n    include: {\n      versions: {\n        where: { active: true },\n        include: { dependencies: true },\n      },\n    },\n  });\n\n  const blockingFormulas: string[] = [];\n  for (const f of activeFormulas) {\n    const activeVer = f.versions[0];\n    if (activeVer && activeVer.dependencies.some((d) => d.variableKey === def.key)) {\n      blockingFormulas.push(f.name);\n    }\n  }\n\n  if (blockingFormulas.length > 0) {\n    throw new ApiError(\n      CODES.VALIDATION_FAILED,\n      `${def.displayName} is used by ${blockingFormulas.join(", ")} and cannot be archived until those formulas are updated.`,\n      422\n    );\n  }'''
new = '''  // Historical FormulaVersions can still be used by delayed billing. A custom\n  // variable therefore cannot be globally archived after ANY persisted formula\n  // version has depended on it, even when today's active version no longer does.\n  const dependentVersions = await db.formulaVersion.findMany({\n    where: {\n      definition: { institutionId: input.institutionId },\n      dependencies: { some: { variableKey: def.key } },\n    },\n    include: { definition: { select: { name: true } } },\n  });\n  const blockingFormulas = [...new Set(dependentVersions.map((v) => v.definition.name))];\n\n  if (blockingFormulas.length > 0) {\n    throw new ApiError(\n      CODES.VALIDATION_FAILED,\n      `${def.displayName} is part of saved formula history (${blockingFormulas.join(", ")}) and cannot be archived without rewriting historical billing inputs.`,\n      422\n    );\n  }'''
if s.count(old) != 1:
    raise SystemExit(f"custom variable archive block count={s.count(old)}")
p.write_text(s.replace(old, new, 1))

# Billing lifecycle: CLOSING is generationState, never BillingPeriod.status.
replace_once(
    "src/lib/domain/billing.ts",
    ''' *  - Generation is serialized through a status guard (OPEN → CLOSING) inside a\n *    single transaction: concurrent or repeated generation fails cleanly with\n *    BILLING_ALREADY_BILLED / BILLING_PERIOD_CLOSED.\n *  - Readiness is re-run INSIDE the transaction — anything unready rolls the\n *    period back to OPEN (no half-closed states).''',
    ''' *  - Generation is serialized through generationState (null → CLOSING → COMPLETED)\n *    while BillingPeriod.status remains OPEN until the BILLED commit.\n *  - Readiness is re-run INSIDE the transaction — anything unready rolls the\n *    generation claim back to null (no half-closed states).''',
)
replace_once(
    "src/lib/domain/billing.ts",
    '{ mealInstance: { cutoffAt: { lte: now } } },',
    '{ mealInstance: { lockAt: { lte: now } } },',
)
replace_once(
    "src/lib/domain/billing.ts",
    '''      period.status === "BILLED"\n        ? "This period has already been billed."\n        : period.status === "CLOSING"\n          ? "A billing run is currently in progress."\n          : period.status === "REOPENED"\n            ? "This period was reopened after billing — bills remain authoritative."\n            : undefined,''',
    '''      period.status === "BILLED"\n        ? "This period has already been billed."\n        : period.status === "REOPENED"\n          ? "This period was reopened after billing — bills remain authoritative."\n          : undefined,''',
)
replace_once(
    "src/app/api/v1/admin/billing/periods/[id]/generate/route.ts",
    ''' * readiness inside the OPEN→CLOSING guard; failures roll back cleanly.''',
    ''' * readiness inside the generationState claim; failures roll back cleanly.''',
)
