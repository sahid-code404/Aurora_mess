import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { ApiError, CODES } from "@/lib/errors";
import {
  DEFAULT_DEFICIT_RULES,
  evaluateDeficitPolicyWithRules,
  type DeficitPolicyContext,
  type DeficitRuleResult,
} from "@/lib/domain/policy/deficit-policy";
import type {
  RuleCondition,
  RuleOperand,
  StructuredDecisionRule,
} from "@/lib/domain/rules/engine";
import { parseStructuredRuleSet } from "@/lib/domain/rules/schema";

export const DEFICIT_RULE_KEY = "deficit_meal_restriction";
export const DEFICIT_POLICY_TYPE = "DEFICIT_RESTRICTION";

export const DEFICIT_RULE_FACT_TYPES = {
  has_active_exemption: "boolean",
  deficit_policy_enabled: "boolean",
  deficit_amount: "number",
  deficit_threshold: "number",
  has_due_anchor: "boolean",
  days_overdue: "number",
  grace_period_days: "number",
} as const;

type DeficitFactType = (typeof DEFICIT_RULE_FACT_TYPES)[keyof typeof DEFICIT_RULE_FACT_TYPES];
type RuleValueType = DeficitFactType | "string" | "null";

const deficitRuleResultSchema = z
  .object({
    state: z.enum(["AVAILABLE", "GRACE_PERIOD", "RESTRICTED", "EXEMPTED"]),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100),
  })
  .strict();

export type DeficitRuleSet = StructuredDecisionRule<DeficitRuleResult>[];

export type RuleVersionView = {
  id: string;
  ruleDefinitionId: string;
  version: number;
  checksum: string;
  status: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  createdByUserId: string | null;
  reason: string | null;
  createdAt: string;
  rules: DeficitRuleSet;
};

export type ActiveDeficitRuleSet = {
  source: "DEFAULT" | "PERSISTED";
  policyVersionId: string | null;
  version: number;
  checksum: string;
  rules: DeficitRuleSet;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalRuleJson(rules: readonly StructuredDecisionRule<DeficitRuleResult>[]): string {
  return JSON.stringify(rules);
}

/**
 * PostgreSQL SERIALIZABLE transactions protect both monotonically increasing
 * version numbers and the single-active-version invariant. Prisma reports
 * serialization/write conflicts as P2034; bounded retry is safe because every
 * mutation is enclosed by the transaction and therefore fully rolled back.
 */
async function serializableWrite<T>(work: (tx: any) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      const retryable =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as any).code === "P2034";
      if (!retryable || attempt === 3) throw error;
    }
  }
  throw new Error("RULE_SERIALIZABLE_RETRY_EXHAUSTED");
}

function operandType(operand: RuleOperand): RuleValueType {
  if (operand.source === "FACT") {
    const type = DEFICIT_RULE_FACT_TYPES[operand.key as keyof typeof DEFICIT_RULE_FACT_TYPES];
    if (!type) {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `Unknown deficit-policy fact '${operand.key}'.`,
        422
      );
    }
    return type;
  }

  if (operand.value === null) return "null";
  if (typeof operand.value === "number") return "number";
  if (typeof operand.value === "boolean") return "boolean";
  return "string";
}

function requireOperandType(
  operand: RuleOperand | undefined,
  expected: RuleValueType,
  operator: string
): void {
  if (!operand || operandType(operand) !== expected) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `${operator} requires ${expected} operands in deficit rules.`,
      422
    );
  }
}

function validateConditionSemantics(condition: RuleCondition): void {
  const leftType = operandType(condition.left);

  if ([">", ">=", "<", "<="].includes(condition.operator)) {
    if (leftType !== "number") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `${condition.operator} requires numeric operands in deficit rules.`,
        422
      );
    }
    requireOperandType(condition.right, "number", condition.operator);
    return;
  }

  if (condition.operator === "BETWEEN") {
    if (leftType !== "number") {
      throw new ApiError(CODES.VALIDATION_FAILED, "BETWEEN requires numeric operands in deficit rules.", 422);
    }
    for (const operand of condition.values ?? []) requireOperandType(operand, "number", "BETWEEN");
    return;
  }

  if (condition.operator === "IS_TRUE" || condition.operator === "IS_FALSE") {
    if (leftType !== "boolean") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `${condition.operator} requires a boolean operand in deficit rules.`,
        422
      );
    }
    return;
  }

  if (condition.operator === "IN") {
    for (const operand of condition.values ?? []) {
      const valueType = operandType(operand);
      if (valueType !== leftType && valueType !== "null") {
        throw new ApiError(
          CODES.VALIDATION_FAILED,
          "IN values must use the same value type as the left operand.",
          422
        );
      }
    }
    return;
  }

  if (condition.operator === "==" || condition.operator === "!=") {
    const rightType = condition.right ? operandType(condition.right) : "null";
    if (rightType !== leftType && rightType !== "null" && leftType !== "null") {
      throw new ApiError(
        CODES.VALIDATION_FAILED,
        `${condition.operator} operands must use compatible value types.`,
        422
      );
    }
  }
}

function validateDeficitRuleSemantics(rules: readonly StructuredDecisionRule<DeficitRuleResult>[]): void {
  for (const rule of rules) {
    for (const condition of rule.when.conditions) validateConditionSemantics(condition);
  }
}

export function parseDeficitRuleSet(input: unknown): DeficitRuleSet {
  const parsed = parseStructuredRuleSet(input, deficitRuleResultSchema);
  const seen = new Set<string>();
  for (const rule of parsed) {
    if (seen.has(rule.id)) {
      throw new ApiError(CODES.VALIDATION_FAILED, `Duplicate rule id '${rule.id}'.`, 422);
    }
    seen.add(rule.id);
  }
  validateDeficitRuleSemantics(parsed);
  return parsed;
}

function normalizeRuleVersion(rules: DeficitRuleSet, version: number): DeficitRuleSet {
  return rules.map((rule) => ({ ...rule, version }));
}

function parseStoredRules(row: { rulesJson: string; checksum: string }): DeficitRuleSet {
  let raw: unknown;
  try {
    raw = JSON.parse(row.rulesJson);
  } catch {
    throw new ApiError(CODES.INTERNAL, "Stored rule data is invalid.", 500);
  }

  const rules = parseDeficitRuleSet(raw);
  const canonical = canonicalRuleJson(rules);
  if (sha256(canonical) !== row.checksum) {
    throw new ApiError(CODES.RESOURCE_CHANGED, "Stored rule checksum does not match its contents.", 409);
  }
  return rules;
}

export function serializeRuleVersion(row: any): RuleVersionView {
  return {
    id: row.id,
    ruleDefinitionId: row.ruleDefinitionId,
    version: row.version,
    checksum: row.checksum,
    status: row.status,
    effectiveFrom: row.effectiveFrom ? new Date(row.effectiveFrom).toISOString() : null,
    effectiveUntil: row.effectiveUntil ? new Date(row.effectiveUntil).toISOString() : null,
    createdByUserId: row.createdByUserId ?? null,
    reason: row.reason ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    rules: parseStoredRules(row),
  };
}

async function ensureDeficitDefinition(institutionId: string, client: any = db): Promise<any> {
  return client.ruleDefinition.upsert({
    where: { institutionId_key: { institutionId, key: DEFICIT_RULE_KEY } },
    update: {},
    create: {
      institutionId,
      key: DEFICIT_RULE_KEY,
      name: "Deficit Meal Restriction",
      description: "Controls resident meal access when available funds fall beyond the configured deficit threshold.",
      policyType: DEFICIT_POLICY_TYPE,
      status: "ACTIVE",
    },
  });
}

async function findDeficitDefinition(institutionId: string, client: any = db): Promise<any | null> {
  return client.ruleDefinition.findUnique({
    where: { institutionId_key: { institutionId, key: DEFICIT_RULE_KEY } },
  });
}

/**
 * Ensures the candidate produces a decision across the core boundary shapes.
 * This does not force the legacy outcome; admins may intentionally change
 * policy. It only prevents activating a rule set with obvious decision holes.
 */
export function validateDeficitRuleCoverage(rules: readonly StructuredDecisionRule<DeficitRuleResult>[]): void {
  const now = new Date("2026-09-05T00:00:00.000Z");
  const day = 86_400_000;
  const samples: DeficitPolicyContext[] = [
    {
      availableMinor: -500000,
      deficitThresholdMinor: 100000,
      gracePeriodDays: 7,
      deficitPolicyEnabled: true,
      oldestUnsettledDueAt: new Date(now.getTime() - 20 * day),
      activeExemptionExpiresAt: new Date(now.getTime() + 5 * day),
      hasActiveExemption: true,
      now,
    },
    {
      availableMinor: -500000,
      deficitThresholdMinor: 100000,
      gracePeriodDays: 7,
      deficitPolicyEnabled: false,
      oldestUnsettledDueAt: new Date(now.getTime() - 20 * day),
      activeExemptionExpiresAt: null,
      hasActiveExemption: false,
      now,
    },
    {
      availableMinor: -100000,
      deficitThresholdMinor: 100000,
      gracePeriodDays: 7,
      deficitPolicyEnabled: true,
      oldestUnsettledDueAt: null,
      activeExemptionExpiresAt: null,
      hasActiveExemption: false,
      now,
    },
    {
      availableMinor: -100001,
      deficitThresholdMinor: 100000,
      gracePeriodDays: 7,
      deficitPolicyEnabled: true,
      oldestUnsettledDueAt: null,
      activeExemptionExpiresAt: null,
      hasActiveExemption: false,
      now,
    },
    {
      availableMinor: -100001,
      deficitThresholdMinor: 100000,
      gracePeriodDays: 7,
      deficitPolicyEnabled: true,
      oldestUnsettledDueAt: new Date(now.getTime() - 3 * day),
      activeExemptionExpiresAt: null,
      hasActiveExemption: false,
      now,
    },
    {
      availableMinor: -100001,
      deficitThresholdMinor: 100000,
      gracePeriodDays: 7,
      deficitPolicyEnabled: true,
      oldestUnsettledDueAt: new Date(now.getTime() - 8 * day),
      activeExemptionExpiresAt: null,
      hasActiveExemption: false,
      now,
    },
  ];

  try {
    for (const sample of samples) evaluateDeficitPolicyWithRules(sample, rules);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown rule coverage error";
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Rule set does not cover the required deficit-policy boundary cases: ${message}`,
      422
    );
  }
}

export async function getDeficitRuleOverview(institutionId: string, client: any = db): Promise<{
  definition: any | null;
  versions: RuleVersionView[];
  defaultRules: DeficitRuleSet;
}> {
  const definition = await findDeficitDefinition(institutionId, client);
  if (!definition) {
    return {
      definition: null,
      versions: [],
      defaultRules: normalizeRuleVersion(parseDeficitRuleSet(DEFAULT_DEFICIT_RULES), 1),
    };
  }

  const versions = await client.ruleVersion.findMany({
    where: { ruleDefinitionId: definition.id },
    orderBy: { version: "desc" },
  });

  return {
    definition,
    versions: versions.map(serializeRuleVersion),
    defaultRules: normalizeRuleVersion(parseDeficitRuleSet(DEFAULT_DEFICIT_RULES), 1),
  };
}

export async function createDeficitRuleDraft(input: {
  institutionId: string;
  adminUserId: string;
  requestId: string;
  rules: unknown;
  reason: string;
}): Promise<RuleVersionView> {
  const rawRules = parseDeficitRuleSet(input.rules);

  const created = await serializableWrite(async (tx) => {
    const definition = await ensureDeficitDefinition(input.institutionId, tx);
    const maxVersion = await tx.ruleVersion.aggregate({
      where: { ruleDefinitionId: definition.id },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version ?? 0) + 1;
    const rules = normalizeRuleVersion(rawRules, nextVersion);
    validateDeficitRuleCoverage(rules);

    const rulesJson = canonicalRuleJson(rules);
    const checksum = sha256(rulesJson);
    const version = await tx.ruleVersion.create({
      data: {
        ruleDefinitionId: definition.id,
        version: nextVersion,
        rulesJson,
        checksum,
        status: "DRAFT",
        createdByUserId: input.adminUserId,
        reason: input.reason,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "RULE_VERSION_CREATED",
        entityType: "RULE_VERSION",
        entityId: version.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: "No policy state changed; draft only",
        afterSummary: `Created deficit rule draft v${nextVersion}`,
        metadata: { ruleKey: DEFICIT_RULE_KEY, version: nextVersion, checksum },
      },
      tx
    );

    return version;
  });

  return serializeRuleVersion(created);
}

export async function resolveActiveDeficitRuleSet(
  institutionId: string,
  client: any = db
): Promise<ActiveDeficitRuleSet> {
  const definition = await findDeficitDefinition(institutionId, client);
  if (definition) {
    const now = new Date();
    const active = await client.ruleVersion.findFirst({
      where: {
        ruleDefinitionId: definition.id,
        status: "ACTIVE",
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
          { OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }] },
        ],
      },
      orderBy: { version: "desc" },
    });
    if (active) {
      return {
        source: "PERSISTED",
        policyVersionId: active.id,
        version: active.version,
        checksum: active.checksum,
        rules: parseStoredRules(active),
      };
    }
  }

  const rules = normalizeRuleVersion(parseDeficitRuleSet(DEFAULT_DEFICIT_RULES), 1);
  return {
    source: "DEFAULT",
    policyVersionId: null,
    version: 1,
    checksum: sha256(canonicalRuleJson(rules)),
    rules,
  };
}

async function loadCandidate(
  institutionId: string,
  input: { versionId?: string; rules?: unknown }
): Promise<{ rules: DeficitRuleSet; checksum: string; versionId: string | null; version: number }> {
  if (input.versionId) {
    const row = await db.ruleVersion.findUnique({
      where: { id: input.versionId },
      include: { definition: true },
    });
    if (!row || row.definition.institutionId !== institutionId || row.definition.key !== DEFICIT_RULE_KEY) {
      throw new ApiError(CODES.NOT_FOUND, "Deficit rule version not found.", 404);
    }
    return {
      rules: parseStoredRules(row),
      checksum: row.checksum,
      versionId: row.id,
      version: row.version,
    };
  }

  if (input.rules === undefined) {
    throw new ApiError(CODES.VALIDATION_FAILED, "Provide a rule version or a candidate rule set.", 422);
  }

  const rules = parseDeficitRuleSet(input.rules);
  validateDeficitRuleCoverage(rules);
  const canonical = canonicalRuleJson(rules);
  return {
    rules,
    checksum: sha256(canonical),
    versionId: null,
    version: Math.max(...rules.map((rule) => rule.version)),
  };
}

export async function simulateDeficitRuleSet(input: {
  institutionId: string;
  versionId?: string;
  rules?: unknown;
  context: DeficitPolicyContext;
}): Promise<any> {
  const candidate = await loadCandidate(input.institutionId, input);
  validateDeficitRuleCoverage(candidate.rules);
  const current = await resolveActiveDeficitRuleSet(input.institutionId);

  const candidateDecision = evaluateDeficitPolicyWithRules(input.context, candidate.rules);
  const currentDecision = evaluateDeficitPolicyWithRules(input.context, current.rules);

  return {
    candidate: {
      versionId: candidate.versionId,
      version: candidate.version,
      checksum: candidate.checksum,
      decision: candidateDecision,
    },
    current: {
      source: current.source,
      policyVersionId: current.policyVersionId,
      version: current.version,
      checksum: current.checksum,
      decision: currentDecision,
    },
    changed:
      candidateDecision.state !== currentDecision.state ||
      candidateDecision.reasonCode !== currentDecision.reasonCode ||
      candidateDecision.graceUntilIso !== currentDecision.graceUntilIso,
  };
}

export async function activateDeficitRuleVersion(input: {
  institutionId: string;
  adminUserId: string;
  requestId: string;
  versionId: string;
  expectedChecksum: string;
  confirmImpact: boolean;
  reason: string;
}): Promise<RuleVersionView> {
  if (!input.confirmImpact) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "Simulate and confirm the rule impact before activation.",
      422
    );
  }

  const activated = await serializableWrite(async (tx) => {
    const candidate = await tx.ruleVersion.findUnique({
      where: { id: input.versionId },
      include: { definition: true },
    });

    if (
      !candidate ||
      candidate.definition.institutionId !== input.institutionId ||
      candidate.definition.key !== DEFICIT_RULE_KEY
    ) {
      throw new ApiError(CODES.NOT_FOUND, "Deficit rule version not found.", 404);
    }
    if (candidate.status !== "DRAFT") {
      throw new ApiError(CODES.RESOURCE_CHANGED, "Only a draft rule version can be activated.", 409);
    }
    if (candidate.checksum !== input.expectedChecksum) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This rule version changed after simulation. Simulate it again before activation.",
        409
      );
    }

    const rules = parseStoredRules(candidate);
    validateDeficitRuleCoverage(rules);

    const now = new Date();
    const previousUntil = new Date(now.getTime() - 1);
    await tx.ruleVersion.updateMany({
      where: {
        ruleDefinitionId: candidate.ruleDefinitionId,
        id: { not: candidate.id },
        status: "ACTIVE",
      },
      data: { status: "HISTORICAL", effectiveUntil: previousUntil },
    });

    const updated = await tx.ruleVersion.update({
      where: { id: candidate.id },
      data: {
        status: "ACTIVE",
        effectiveFrom: now,
        effectiveUntil: null,
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "RULE_VERSION_ACTIVATED_SHADOW",
        entityType: "RULE_VERSION",
        entityId: updated.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSummary: "Legacy deficit policy remains authoritative",
        afterSummary: `Activated deficit rule v${updated.version} for shadow evaluation`,
        metadata: {
          ruleKey: DEFICIT_RULE_KEY,
          version: updated.version,
          checksum: updated.checksum,
          authority: "SHADOW_ONLY",
        },
      },
      tx
    );

    return updated;
  });

  return serializeRuleVersion(activated);
}
