from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one replacement, found {count} for {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))


def replace_between(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    p = Path(path)
    s = p.read_text()
    start = s.find(start_marker)
    if start < 0:
        raise SystemExit(f"{path}: start marker not found: {start_marker[:100]!r}")
    end = s.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"{path}: end marker not found: {end_marker[:100]!r}")
    p.write_text(s[:start] + replacement + s[end:])


# ---------------------------------------------------------------------------
# 1. FormulaDefinition advertised ACTIVE | ARCHIVED but no archive/reactivate
#    transition exists. FormulaVersion effective windows are the real lifecycle.
# ---------------------------------------------------------------------------
replace_once(
    "prisma/schema.prisma",
    '''  scope             String    @default("BILLING_PERIOD") // GLOBAL | BILLING_PERIOD | RESIDENT | MEAL\n  status            String    @default("ACTIVE") // ACTIVE | ARCHIVED\n  activeVersionId   String?\n  archivedAt        DateTime?\n  createdAt         DateTime  @default(now())''',
    '''  scope             String    @default("BILLING_PERIOD") // GLOBAL | BILLING_PERIOD | RESIDENT | MEAL\n  activeVersionId   String?\n  createdAt         DateTime  @default(now())''',
)

# ---------------------------------------------------------------------------
# 2. Formula readers use immutable effective windows, never the latest `active`
#    pointer, when resolving a historical/current billing period.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/domain/formula/versions.ts",
    'import { gatherAllVariables } from "./registry";\n',
    'import { gatherAllVariables } from "./registry";\nimport { selectFormulaVersionAt } from "./effective-version";\n',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    'where: { institutionId, outputVariableKey, archivedAt: null },',
    'where: { institutionId, outputVariableKey },',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    '''        outputVariableKey,\n        scope: "BILLING_PERIOD",\n        status: "ACTIVE",''',
    '''        outputVariableKey,\n        scope: "BILLING_PERIOD",''',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    '''  const farPast = new Date(-864e13);\n  const farFuture = new Date(864e13);\n  return (\n    versions.find(\n      (v: any) =>\n        (v.effectiveFrom ? new Date(v.effectiveFrom) : farPast) <= periodStart &&\n        (v.effectiveUntil ? new Date(v.effectiveUntil) : farFuture) >= periodStart\n    ) ?? null\n  );''',
    '''  return selectFormulaVersionAt(versions, periodStart);''',
)

replace_between(
    "src/lib/domain/formula/versions.ts",
    '  // 1. DAG cycle check (spec §44)\n',
    '  // Validate no circular dependency\n',
    '''  // 1. DAG cycle check (spec §44). Resolve every dependency formula for\n  // the same effective period as the candidate; the latest active pointer can\n  // point at NEXT_PERIOD and must never rewrite current/historical evaluation.\n  const nextYear = bounds.month === 12 ? bounds.year + 1 : bounds.year;\n  const nextMonth = bounds.month === 12 ? 1 : bounds.month + 1;\n  const nextMonthFirst = localDateMidnightUtc(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`);\n  const targetPeriodStart = input.effective === "CURRENT_OPEN" ? bounds.startAt : nextMonthFirst;\n\n  const allFormulaDefs = await db.formulaDefinition.findMany({\n    where: { institutionId: input.institutionId },\n    include: {\n      versions: {\n        orderBy: { version: "desc" },\n        include: { dependencies: true },\n      },\n    },\n  });\n\n  const dag = new FormulaDag();\n  for (const def of allFormulaDefs) {\n    if (def.outputVariableKey === outputKey) continue;\n    const periodVersion = selectFormulaVersionAt(def.versions, targetPeriodStart);\n    if (!periodVersion) continue;\n    try {\n      const nodeAst = JSON.parse(periodVersion.compiledAstJson) as FormulaAst;\n      dag.addNode({\n        outputVariableKey: def.outputVariableKey,\n        formulaDefinitionId: def.id,\n        name: def.name,\n        ast: nodeAst,\n        dependsOn: periodVersion.dependencies.map((d: any) => d.variableKey),\n      });\n    } catch {\n      // ignore malformed legacy formula rows here; activation/build gates handle them\n    }\n  }\n\n''',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    '''  // 4. Compute effective window\n  const nextYear = bounds.month === 12 ? bounds.year + 1 : bounds.year;\n  const nextMonth = bounds.month === 12 ? 1 : bounds.month + 1;\n  const nextMonthFirst = localDateMidnightUtc(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`);\n  const thisMonthEnd = new Date(nextMonthFirst.getTime() - 1);\n\n  const effectiveFrom = input.effective === "CURRENT_OPEN" ? bounds.startAt : nextMonthFirst;''',
    '''  // 4. Compute effective window\n  const thisMonthEnd = new Date(nextMonthFirst.getTime() - 1);\n  const effectiveFrom = targetPeriodStart;''',
)

# Registry resolves formulas by the requested period, not by active=true.
replace_once(
    "src/lib/domain/formula/registry.ts",
    'import { FormulaAst } from "./ast";\n',
    'import { FormulaAst } from "./ast";\nimport { selectFormulaVersionAt } from "./effective-version";\n',
)
replace_once(
    "src/lib/domain/formula/registry.ts",
    '''    client.variableDefinition.findMany({\n      where: { institutionId, archivedAt: null },\n    }),\n    client.formulaDefinition.findMany({\n      where: { institutionId, status: "ACTIVE", archivedAt: null },\n      include: {\n        versions: {\n          where: { active: true },\n          include: { dependencies: true },\n        },\n      },\n    }),''',
    '''    client.variableDefinition.findMany({\n      where: {\n        institutionId,\n        OR: [{ archivedAt: null }, { archivedAt: { gt: bounds.startAt } }],\n      },\n    }),\n    client.formulaDefinition.findMany({\n      where: { institutionId },\n      include: {\n        versions: {\n          orderBy: { version: "desc" },\n          include: { dependencies: true },\n        },\n      },\n    }),''',
)
replace_once(
    "src/lib/domain/formula/registry.ts",
    '''  const kitchenVars = resolveKitchenVariables(\n    mealVars.total_resident_meals,\n    guestVars.total_guest_meals\n  );''',
    '''  const formulaDefsForPeriod = formulaDefs.flatMap((def: any) => {\n    const periodVersion = selectFormulaVersionAt(def.versions, bounds.startAt);\n    return periodVersion ? [{ ...def, versions: [periodVersion] }] : [];\n  });\n\n  const kitchenVars = resolveKitchenVariables(\n    mealVars.total_resident_meals,\n    guestVars.total_guest_meals\n  );''',
)
# Remaining formulaDefs references are all period-scoped consumers below the
# declaration/Promise block.
p = Path("src/lib/domain/formula/registry.ts")
s = p.read_text()
anchor = s.index("  const formulaDefsForPeriod =")
prefix, tail = s[:anchor], s[anchor:]
tail = tail.replace("for (const def of formulaDefs)", "for (const def of formulaDefsForPeriod)")
tail = tail.replace("const usedBy = formulaDefs\n", "const usedBy = formulaDefsForPeriod\n")
tail = tail.replace("for (const f of formulaDefs)", "for (const f of formulaDefsForPeriod)")
p.write_text(prefix + tail)

# Custom provider keeps archived variables available to periods that started
# before the archive boundary, preserving delayed historical billing.
replace_once(
    "src/lib/domain/formula/providers/custom.ts",
    '''      category: "CUSTOM",\n      archivedAt: null,''',
    '''      category: "CUSTOM",\n      OR: [{ archivedAt: null }, { archivedAt: { gt: bounds.startAt } }],''',
)

# Formula preview downstream DAG follows the previewed period's effective windows.
replace_once(
    "src/app/api/v1/admin/formulas/preview/route.ts",
    'import { FormulaDag } from "@/lib/domain/formula/dag";\n',
    'import { FormulaDag } from "@/lib/domain/formula/dag";\nimport { selectFormulaVersionAt } from "@/lib/domain/formula/effective-version";\n',
)
replace_once(
    "src/app/api/v1/admin/formulas/preview/route.ts",
    '''  const allDefs = await db.formulaDefinition.findMany({\n    where: { institutionId: ctx.institutionId, status: "ACTIVE", archivedAt: null },\n    include: { versions: { where: { active: true }, include: { dependencies: true } } },\n  });\n  const dag = new FormulaDag();\n  for (const d of allDefs) {\n    if (d.versions[0]) {\n      try {\n        dag.addNode({\n          outputVariableKey: d.outputVariableKey,\n          name: d.name,\n          ast: JSON.parse(d.versions[0].compiledAstJson),\n          dependsOn: d.versions[0].dependencies.map((dep) => dep.variableKey),\n        });\n      } catch {\n        // ignore\n      }\n    }\n  }''',
    '''  const allDefs = await db.formulaDefinition.findMany({\n    where: { institutionId: ctx.institutionId },\n    include: {\n      versions: { orderBy: { version: "desc" }, include: { dependencies: true } },\n    },\n  });\n  const dag = new FormulaDag();\n  for (const d of allDefs) {\n    const periodVersion = selectFormulaVersionAt(d.versions, bounds.startAt);\n    if (!periodVersion) continue;\n    try {\n      dag.addNode({\n        outputVariableKey: d.outputVariableKey,\n        name: d.name,\n        ast: JSON.parse(periodVersion.compiledAstJson),\n        dependsOn: periodVersion.dependencies.map((dep) => dep.variableKey),\n      });\n    } catch {\n      // ignore\n    }\n  }''',
)

# Admin FormulaDefinition API no longer reads/writes dead archive state.
replace_once(
    "src/app/api/v1/admin/formulas/route.ts",
    'where: { institutionId: ctx.institutionId, archivedAt: null },',
    'where: { institutionId: ctx.institutionId },',
)
replace_once(
    "src/app/api/v1/admin/formulas/route.ts",
    '''        outputVariableKey: d.outputVariableKey,\n        scope: d.scope,\n        status: d.status,\n        activeVersion:''',
    '''        outputVariableKey: d.outputVariableKey,\n        scope: d.scope,\n        activeVersion:''',
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

# ---------------------------------------------------------------------------
# 3. Custom-variable values are formula inputs. Mutations share the Institution
#    billing mutex and decide frozen-period state only after that lock.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    'import { localDateMidnightUtc } from "@/lib/time";\n',
    'import { localDateMidnightUtc } from "@/lib/time";\nimport { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";\nimport { assertFormulaInputPeriodMutable } from "./period-mutation";\n',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''  return await db.$transaction(async (tx) => {\n    const def = await tx.variableDefinition.create({''',
    '''  return await db.$transaction(async (tx) => {\n    if (input.effectivePeriod) {\n      const match = /^(\\d{4})-(\\d{2})$/.exec(input.effectivePeriod);\n      if (!match) throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 400);\n      const month = Number(match[2]);\n      if (month < 1 || month > 12) {\n        throw new ApiError(CODES.VALIDATION_FAILED, "Period month must be between 01 and 12.", 400);\n      }\n      await lockInstitutionFinancialMutation(tx, input.institutionId);\n      await assertFormulaInputPeriodMutable(tx, input.institutionId, Number(match[1]), month);\n    }\n\n    const def = await tx.variableDefinition.create({''',
)

p = Path("src/lib/domain/formula/custom-variables.ts")
s = p.read_text()
start = s.index("export async function setCustomVariableValue(")
end = s.index("\nexport async function archiveCustomVariable(", start)
new_fn = '''export async function setCustomVariableValue(input: {\n  institutionId: string;\n  adminUserId: string;\n  variableDefinitionId: string;\n  billingPeriodKey: string; // "YYYY-MM"\n  value: number;\n}) {\n  const match = /^(\\d{4})-(\\d{2})$/.exec(input.billingPeriodKey);\n  if (!match) {\n    throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 400);\n  }\n  const year = Number(match[1]);\n  const month = Number(match[2]);\n  if (month < 1 || month > 12) {\n    throw new ApiError(CODES.VALIDATION_FAILED, "Period month must be between 01 and 12.", 400);\n  }\n  const periodStart = localDateMidnightUtc(`${input.billingPeriodKey}-01`);\n\n  return await db.$transaction(async (tx) => {\n    await lockInstitutionFinancialMutation(tx, input.institutionId);\n    await assertFormulaInputPeriodMutable(tx, input.institutionId, year, month);\n\n    const def = await tx.variableDefinition.findFirst({\n      where: { id: input.variableDefinitionId, institutionId: input.institutionId, archivedAt: null },\n    });\n    if (!def) {\n      throw new ApiError(CODES.NOT_FOUND, "Custom variable not found.", 404);\n    }\n\n    const isMoney = def.valueType === "MONEY";\n    const existingVal = await tx.customVariableValue.findFirst({\n      where: { variableDefinitionId: def.id, billingPeriodKey: input.billingPeriodKey },\n    });\n\n    const valRow = existingVal\n      ? await tx.customVariableValue.update({\n          where: { id: existingVal.id },\n          data: {\n            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney ? input.value : null,\n            createdByUserId: input.adminUserId,\n            updatedAt: new Date(),\n          },\n        })\n      : await tx.customVariableValue.create({\n          data: {\n            variableDefinitionId: def.id,\n            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney ? input.value : null,\n            effectiveFrom: periodStart,\n            billingPeriodKey: input.billingPeriodKey,\n            createdByUserId: input.adminUserId,\n          },\n        });\n\n    await appendAudit(\n      {\n        institutionId: input.institutionId,\n        actorUserId: input.adminUserId,\n        actorRole: "ADMIN",\n        action: "CUSTOM_VARIABLE_VALUE_UPDATED",\n        entityType: "VARIABLE_DEFINITION",\n        entityId: def.id,\n        requestId: `var-val-${def.id}`,\n        beforeSummary: existingVal ? `Value was ${existingVal.valueMinor ?? existingVal.valueNumber}` : "Not set",\n        afterSummary: `Period ${input.billingPeriodKey} set to ${input.value}`,\n        metadata: { key: def.key, period: input.billingPeriodKey, value: input.value },\n      },\n      tx\n    );\n\n    return valRow;\n  });\n}\n'''
p.write_text(s[:start] + new_fn + s[end:])

# FormulaDefinition status/archive fields disappear, but custom-variable archive
# still blocks a variable used by the latest configured formula version. Archived
# variables remain readable for periods that predate archivedAt (provider above).
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    'where: { institutionId: input.institutionId, status: "ACTIVE", archivedAt: null },',
    'where: { institutionId: input.institutionId },',
)

# ---------------------------------------------------------------------------
# 4. Billing CLOSING is generationState, never BillingPeriod.status. Also use
#    authoritative lockAt when deciding frozen resident meals.
# ---------------------------------------------------------------------------
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
    ' * readiness inside the OPEN→CLOSING guard; failures roll back cleanly.',
    ' * readiness inside the generationState claim; failures roll back cleanly.',
)

print("Phase 67 patch applied")
