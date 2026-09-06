/**
 * CUSTOM VARIABLE SERVICE (spec §17-21, §64-65, §67-68, §72-73, §83-84, §92-93, §123-124)
 *
 * Manages Admin custom variables with strict validation:
 *  - Reserved system variable keys cannot be claimed
 *  - Duplicate keys rejected
 *  - Values are versioned per period; closed historical periods are immutable
 *  - Variables used by active formulas cannot be archived
 */
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";
import { appendAudit } from "@/lib/audit";
import { localDateMidnightUtc } from "@/lib/time";
import { lockInstitutionFinancialMutation } from "@/lib/domain/financial-lock";
import { assertFormulaInputPeriodMutable } from "./period-mutation";
import {
  generateKeyFromName,
  isValidVariableKey,
  SYSTEM_VARIABLES_MAP,
  VariableFrequency,
  VariableScope,
  VariableUnit,
  VariableValueType,
} from "./variables";

export interface CreateCustomVariableInput {
  institutionId: string;
  adminUserId: string;
  name: string;
  key?: string;
  description?: string;
  valueType: VariableValueType;
  unit: VariableUnit;
  scope?: VariableScope;
  frequency?: VariableFrequency;
  initialValue: number;
  effectivePeriod?: string; // "YYYY-MM" e.g. "2026-09"
  effectiveFrom?: string; // ISO date
  effectiveUntil?: string; // ISO date
}

export async function createCustomVariable(input: CreateCustomVariableInput) {
  const key = (input.key ? input.key.trim().toLowerCase() : generateKeyFromName(input.name)).trim();

  if (!isValidVariableKey(key)) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Variable key '${key}' is invalid. Keys must start with a letter and contain only lowercase letters, digits, and underscores.`,
      422
    );
  }

  // Check system collision (spec §84)
  if (SYSTEM_VARIABLES_MAP[key]) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `'${key}' is a reserved system variable key and cannot be used for a custom variable.`,
      422
    );
  }

  // Check existing active variable
  const existing = await db.variableDefinition.findFirst({
    where: {
      institutionId: input.institutionId,
      key,
      archivedAt: null,
    },
  });

  if (existing) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `A variable with key '${key}' already exists (${existing.displayName}). Update its value instead.`,
      422
    );
  }

  // Determine effective dates
  let effectiveFromDate: Date;
  if (input.effectiveFrom) {
    effectiveFromDate = new Date(input.effectiveFrom);
  } else if (input.effectivePeriod) {
    effectiveFromDate = localDateMidnightUtc(`${input.effectivePeriod}-01`);
  } else {
    effectiveFromDate = new Date();
  }

  const effectiveUntilDate = input.effectiveUntil ? new Date(input.effectiveUntil) : null;
  const isMoney = input.valueType === "MONEY";
  const isBoolean = input.valueType === "BOOLEAN";
  if (isBoolean && input.initialValue !== 0 && input.initialValue !== 1) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Boolean variables use 0 (false) or 1 (true).", 422);
  }

  return await db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, input.institutionId);
    if (input.effectivePeriod) {
      const match = /^(\d{4})-(\d{2})$/.exec(input.effectivePeriod);
      if (!match) throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 400);
      const month = Number(match[2]);
      if (month < 1 || month > 12) {
        throw new ApiError(CODES.VALIDATION_FAILED, "Period month must be between 01 and 12.", 400);
      }
      await assertFormulaInputPeriodMutable(tx, input.institutionId, Number(match[1]), month);
    }

    const def = await tx.variableDefinition.create({
      data: {
        institutionId: input.institutionId,
        key,
        displayName: input.name.trim(),
        description: input.description?.trim() || `${input.name} custom variable`,
        category: "CUSTOM",
        valueType: input.valueType,
        unit: input.unit,
        scope: input.scope ?? "BILLING_PERIOD",
        frequency: input.frequency ?? "MONTHLY",
        createdByUserId: input.adminUserId,
      },
    });

    const val = await tx.customVariableValue.create({
      data: {
        variableDefinitionId: def.id,
        valueMinor: isMoney ? input.initialValue : null,
        valueNumber: !isMoney && !isBoolean ? input.initialValue : null,
        valueBoolean: isBoolean ? input.initialValue === 1 : null,
        effectiveFrom: effectiveFromDate,
        effectiveUntil: effectiveUntilDate,
        billingPeriodKey: input.effectivePeriod ?? null,
        createdByUserId: input.adminUserId,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "CUSTOM_VARIABLE_CREATED",
        entityType: "VARIABLE_DEFINITION",
        entityId: def.id,
        requestId: `var-create-${def.id}`,
        beforeSummary: "none",
        afterSummary: `${def.displayName} (${def.key}) = ${input.initialValue}`,
        metadata: { key: def.key, value: input.initialValue, unit: def.unit },
      },
      tx
    );

    return { definition: def, initialValue: val };
  });
}

export async function setCustomVariableValue(input: {
  institutionId: string;
  adminUserId: string;
  variableDefinitionId: string;
  billingPeriodKey: string; // "YYYY-MM"
  value: number;
}) {
  const match = /^(\d{4})-(\d{2})$/.exec(input.billingPeriodKey);
  if (!match) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Period must be YYYY-MM.", 400);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Period month must be between 01 and 12.", 400);
  }
  const periodStart = localDateMidnightUtc(`${input.billingPeriodKey}-01`);

  return await db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, input.institutionId);
    await assertFormulaInputPeriodMutable(tx, input.institutionId, year, month);

    const def = await tx.variableDefinition.findFirst({
      where: { id: input.variableDefinitionId, institutionId: input.institutionId, archivedAt: null },
    });
    if (!def) {
      throw new ApiError(CODES.NOT_FOUND, "Custom variable not found.", 404);
    }

    const isMoney = def.valueType === "MONEY";
    const isBoolean = def.valueType === "BOOLEAN";
    if (isBoolean && input.value !== 0 && input.value !== 1) {
      throw new ApiError(CODES.VALIDATION_FAILED, "Boolean variables use 0 (false) or 1 (true).", 422);
    }
    const existingVal = await tx.customVariableValue.findFirst({
      where: { variableDefinitionId: def.id, billingPeriodKey: input.billingPeriodKey },
    });

    const valRow = existingVal
      ? await tx.customVariableValue.update({
          where: { id: existingVal.id },
          data: {
            valueMinor: isMoney ? input.value : null,
            valueNumber: !isMoney && !isBoolean ? input.value : null,
            valueBoolean: isBoolean ? input.value === 1 : null,
            createdByUserId: input.adminUserId,
            updatedAt: new Date(),
          },
        })
      : await tx.customVariableValue.create({
          data: {
            variableDefinitionId: def.id,
            valueMinor: isMoney ? input.value : null,
            valueNumber: !isMoney && !isBoolean ? input.value : null,
            valueBoolean: isBoolean ? input.value === 1 : null,
            effectiveFrom: periodStart,
            billingPeriodKey: input.billingPeriodKey,
            createdByUserId: input.adminUserId,
          },
        });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "CUSTOM_VARIABLE_VALUE_UPDATED",
        entityType: "VARIABLE_DEFINITION",
        entityId: def.id,
        requestId: `var-val-${def.id}`,
        beforeSummary: existingVal ? `Value was ${existingVal.valueMinor ?? existingVal.valueNumber}` : "Not set",
        afterSummary: `Period ${input.billingPeriodKey} set to ${input.value}`,
        metadata: { key: def.key, period: input.billingPeriodKey, value: input.value },
      },
      tx
    );

    return valRow;
  });
}

export async function archiveCustomVariable(input: {
  institutionId: string;
  adminUserId: string;
  variableDefinitionId: string;
}) {
  return db.$transaction(async (tx) => {
    await lockInstitutionFinancialMutation(tx, input.institutionId);

    const def = await tx.variableDefinition.findFirst({
      where: { id: input.variableDefinitionId, institutionId: input.institutionId, archivedAt: null },
    });
    if (!def) {
      throw new ApiError(CODES.NOT_FOUND, "Custom variable not found.", 404);
    }

    // The latest configured FormulaVersion may be current or scheduled for the
    // next period. Either way, do not archive a variable that configuration
    // still depends on. Historical periods remain readable because the provider
    // includes definitions whose archivedAt is after the period start.
    const configuredFormulas = await tx.formulaDefinition.findMany({
      where: { institutionId: input.institutionId },
      include: {
        versions: {
          where: { active: true },
          include: { dependencies: true },
        },
      },
    });

    const blockingFormulas: string[] = [];
    for (const formula of configuredFormulas) {
      const configuredVersion = formula.versions[0];
      if (configuredVersion?.dependencies.some((dependency) => dependency.variableKey === def.key)) {
        blockingFormulas.push(formula.name);
      }
    }
    if (blockingFormulas.length > 0) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `${def.displayName} is used by ${blockingFormulas.join(", ")} and cannot be archived until those formulas are updated.`,
        422
      );
    }

    const updated = await tx.variableDefinition.update({
      where: { id: def.id },
      data: { archivedAt: new Date() },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "CUSTOM_VARIABLE_ARCHIVED",
        entityType: "VARIABLE_DEFINITION",
        entityId: def.id,
        requestId: `var-archive-${def.id}`,
        beforeSummary: "ACTIVE",
        afterSummary: "ARCHIVED",
        metadata: { key: def.key },
      },
      tx
    );

    return updated;
  });
}

export async function togglePinVariable(input: {
  institutionId: string;
  variableKey: string;
}) {
  const existing = await db.variableDefinition.findFirst({
    where: { institutionId: input.institutionId, key: input.variableKey },
  });

  if (existing) {
    return await db.variableDefinition.update({
      where: { id: existing.id },
      data: { isPinned: !existing.isPinned },
    });
  }

  // If pinning a system variable, create a record to store pin state
  const sys = SYSTEM_VARIABLES_MAP[input.variableKey];
  if (!sys) {
    throw new ApiError(CODES.NOT_FOUND, "Variable not found.", 404);
  }

  return await db.variableDefinition.create({
    data: {
      institutionId: input.institutionId,
      key: sys.key,
      displayName: sys.displayName,
      description: sys.description,
      category: "SYSTEM",
      valueType: sys.valueType,
      unit: sys.unit,
      scope: sys.scope,
      isPinned: true,
    },
  });
}
