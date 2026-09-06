from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 occurrence, found {count}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))


def replace_between(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    p = Path(path)
    s = p.read_text()
    start = s.find(start_marker)
    end = s.find(end_marker, start + 1) if start >= 0 else -1
    if start < 0 or end < 0:
        raise SystemExit(f"{path}: replacement markers not found")
    p.write_text(s[:start] + replacement + s[end:])


# Formula writes share the Institution mutex with billing/custom-variable writes.
replace_once(
    "src/lib/domain/formula/versions.ts",
    'import { selectFormulaVersionAt } from "./effective-version";\n',
    'import { selectFormulaVersionAt } from "./effective-version";\nimport { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";\nimport { assertFormulaInputPeriodMutable } from "./period-mutation";\n',
)

helper = '''async function buildFormulaDagForPeriod(\n  client: any,\n  institutionId: string,\n  outputKey: string,\n  targetPeriodStart: Date\n): Promise<FormulaDag> {\n  const allFormulaDefs = await client.formulaDefinition.findMany({\n    where: { institutionId },\n    include: {\n      versions: {\n        orderBy: { version: "desc" },\n        include: { dependencies: true },\n      },\n    },\n  });\n\n  const dag = new FormulaDag();\n  for (const def of allFormulaDefs) {\n    if (def.outputVariableKey === outputKey) continue;\n    const periodVersion = selectFormulaVersionAt(def.versions, targetPeriodStart);\n    if (!periodVersion) continue;\n    try {\n      const nodeAst = JSON.parse(periodVersion.compiledAstJson) as FormulaAst;\n      dag.addNode({\n        outputVariableKey: def.outputVariableKey,\n        formulaDefinitionId: def.id,\n        name: def.name,\n        ast: nodeAst,\n        dependsOn: periodVersion.dependencies.map((d: any) => d.variableKey),\n      });\n    } catch {\n      // Ignore malformed legacy rows here; normal activation/build validation\n      // remains fail-closed for newly persisted formula data.\n    }\n  }\n  return dag;\n}\n\n'''
replace_once(
    "src/lib/domain/formula/versions.ts",
    '/** Create a new immutable formula version with DAG cycle detection. */\n',
    helper + '/** Create a new immutable formula version with DAG cycle detection. */\n',
)
replace_between(
    "src/lib/domain/formula/versions.ts",
    '  const allFormulaDefs = await db.formulaDefinition.findMany({\n',
    '  // Validate no circular dependency\n',
    '''  const dag = await buildFormulaDagForPeriod(\n    db,\n    input.institutionId,\n    outputKey,\n    targetPeriodStart\n  );\n\n''',
)
replace_once(
    "src/lib/domain/formula/versions.ts",
    '''  const version = await db.$transaction(async (tx) => {\n    const definition = await ensureFormulaDefinition(input.institutionId, outputKey, tx);''',
    '''  const version = await db.$transaction(async (tx) => {\n    await lockInstitutionFinancialMutation(tx, input.institutionId);\n    const targetYear = input.effective === "CURRENT_OPEN" ? bounds.year : nextYear;\n    const targetMonth = input.effective === "CURRENT_OPEN" ? bounds.month : nextMonth;\n    await assertFormulaInputPeriodMutable(tx, input.institutionId, targetYear, targetMonth);\n\n    // Preview/cycle checks happen before confirmation for UX, but mutation must\n    // re-check under the shared Institution mutex so two concurrent formula\n    // writes cannot each validate against stale dependency graphs.\n    const lockedDag = await buildFormulaDagForPeriod(\n      tx,\n      input.institutionId,\n      outputKey,\n      targetPeriodStart\n    );\n    lockedDag.validateNoCycles(outputKey, ast);\n\n    const definition = await ensureFormulaDefinition(input.institutionId, outputKey, tx);''',
)

# Custom variable creation always participates in the formula/billing config mutex.
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''  return await db.$transaction(async (tx) => {\n    if (input.effectivePeriod) {''',
    '''  return await db.$transaction(async (tx) => {\n    await lockInstitutionFinancialMutation(tx, input.institutionId);\n    if (input.effectivePeriod) {''',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''      await lockInstitutionFinancialMutation(tx, input.institutionId);\n      await assertFormulaInputPeriodMutable(tx, input.institutionId, Number(match[1]), month);''',
    '''      await assertFormulaInputPeriodMutable(tx, input.institutionId, Number(match[1]), month);''',
)

# BOOLEAN is a real advertised custom-variable type; persist it in valueBoolean
# and accept only 0/1 from the current numeric API contract.
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''  const effectiveUntilDate = input.effectiveUntil ? new Date(input.effectiveUntil) : null;\n  const isMoney = input.valueType === "MONEY";''',
    '''  const effectiveUntilDate = input.effectiveUntil ? new Date(input.effectiveUntil) : null;\n  const isMoney = input.valueType === "MONEY";\n  const isBoolean = input.valueType === "BOOLEAN";\n  if (isBoolean && input.initialValue !== 0 && input.initialValue !== 1) {\n    throw new ApiError(CODES.VALIDATION_FAILED, "Boolean variables use 0 (false) or 1 (true).", 422);\n  }''',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''        valueMinor: isMoney ? input.initialValue : null,\n        valueNumber: !isMoney ? input.initialValue : null,\n        effectiveFrom: effectiveFromDate,''',
    '''        valueMinor: isMoney ? input.initialValue : null,\n        valueNumber: !isMoney && !isBoolean ? input.initialValue : null,\n        valueBoolean: isBoolean ? input.initialValue === 1 : null,\n        effectiveFrom: effectiveFromDate,''',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''    const isMoney = def.valueType === "MONEY";\n    const existingVal = await tx.customVariableValue.findFirst({''',
    '''    const isMoney = def.valueType === "MONEY";\n    const isBoolean = def.valueType === "BOOLEAN";\n    if (isBoolean && input.value !== 0 && input.value !== 1) {\n      throw new ApiError(CODES.VALIDATION_FAILED, "Boolean variables use 0 (false) or 1 (true).", 422);\n    }\n    const existingVal = await tx.customVariableValue.findFirst({''',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney ? input.value : null,\n            createdByUserId: input.adminUserId,''',
    '''            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney && !isBoolean ? input.value : null,\n            valueBoolean: isBoolean ? input.value === 1 : null,\n            createdByUserId: input.adminUserId,''',
)
replace_once(
    "src/lib/domain/formula/custom-variables.ts",
    '''            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney ? input.value : null,\n            effectiveFrom: periodStart,''',
    '''            valueMinor: isMoney ? input.value : null,\n            valueNumber: !isMoney && !isBoolean ? input.value : null,\n            valueBoolean: isBoolean ? input.value === 1 : null,\n            effectiveFrom: periodStart,''',
)

# Archive is one serialized transaction: lock -> authoritative definition read ->
# dependency check -> archive -> audit. Formula creation takes the same mutex.
p = Path("src/lib/domain/formula/custom-variables.ts")
s = p.read_text()
start = s.index("export async function archiveCustomVariable(")
end = s.index("\nexport async function togglePinVariable(", start)
archive_fn = '''export async function archiveCustomVariable(input: {\n  institutionId: string;\n  adminUserId: string;\n  variableDefinitionId: string;\n}) {\n  return db.$transaction(async (tx) => {\n    await lockInstitutionFinancialMutation(tx, input.institutionId);\n\n    const def = await tx.variableDefinition.findFirst({\n      where: { id: input.variableDefinitionId, institutionId: input.institutionId, archivedAt: null },\n    });\n    if (!def) {\n      throw new ApiError(CODES.NOT_FOUND, "Custom variable not found.", 404);\n    }\n\n    // The latest configured FormulaVersion may be current or scheduled for the\n    // next period. Either way, do not archive a variable that configuration\n    // still depends on. Historical periods remain readable because the provider\n    // includes definitions whose archivedAt is after the period start.\n    const configuredFormulas = await tx.formulaDefinition.findMany({\n      where: { institutionId: input.institutionId },\n      include: {\n        versions: {\n          where: { active: true },\n          include: { dependencies: true },\n        },\n      },\n    });\n\n    const blockingFormulas: string[] = [];\n    for (const formula of configuredFormulas) {\n      const configuredVersion = formula.versions[0];\n      if (configuredVersion?.dependencies.some((dependency) => dependency.variableKey === def.key)) {\n        blockingFormulas.push(formula.name);\n      }\n    }\n    if (blockingFormulas.length > 0) {\n      throw new ApiError(\n        CODES.VALIDATION_FAILED,\n        `${def.displayName} is used by ${blockingFormulas.join(", ")} and cannot be archived until those formulas are updated.`,\n        422\n      );\n    }\n\n    const updated = await tx.variableDefinition.update({\n      where: { id: def.id },\n      data: { archivedAt: new Date() },\n    });\n\n    await appendAudit(\n      {\n        institutionId: input.institutionId,\n        actorUserId: input.adminUserId,\n        actorRole: "ADMIN",\n        action: "CUSTOM_VARIABLE_ARCHIVED",\n        entityType: "VARIABLE_DEFINITION",\n        entityId: def.id,\n        requestId: `var-archive-${def.id}`,\n        beforeSummary: "ACTIVE",\n        afterSummary: "ARCHIVED",\n        metadata: { key: def.key },\n      },\n      tx\n    );\n\n    return updated;\n  });\n}\n'''
p.write_text(s[:start] + archive_fn + s[end:])

print("Phase 67 concurrency hardening applied")
