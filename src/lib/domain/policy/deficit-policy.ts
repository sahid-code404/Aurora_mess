/**
 * DEFICIT POLICY SERVICE — first focused Rule Engine use case.
 *
 * Inputs map directly to existing BoardOps financial facts / variables:
 *   availableMinor        ← resident funds read model
 *   deficitThresholdMinor ← deficit_threshold variable / InstitutionSettings
 *   gracePeriodDays       ← grace_period_days variable / InstitutionSettings
 *   deficitPolicyEnabled  ← InstitutionSettings policy switch
 *
 * The service is PURE: it never reads the database and never mutates state.
 * During shadow mode, funds.ts compares this result with the legacy policy and
 * keeps the legacy result authoritative until parity is proven.
 */
import {
  evaluateFirstMatchingRule,
  type RuleFacts,
  type StructuredDecisionRule,
} from "@/lib/domain/rules/engine";

export type DeficitPolicyState = "AVAILABLE" | "GRACE_PERIOD" | "RESTRICTED" | "EXEMPTED";

export type DeficitPolicyContext = {
  availableMinor: number;
  deficitThresholdMinor: number;
  gracePeriodDays: number;
  deficitPolicyEnabled: boolean;
  oldestUnsettledDueAt: Date | null;
  activeExemptionExpiresAt: Date | null;
  hasActiveExemption: boolean;
  now: Date;
};

export type DeficitPolicyDecision = {
  state: DeficitPolicyState;
  reasonCode: string;
  explanation: string;
  ruleVersionId: string;
  graceUntilIso: string | null;
};

type DeficitRuleResult = {
  state: DeficitPolicyState;
  reasonCode: string;
};

const DAY_MS = 86_400_000;
const fact = (key: string) => ({ source: "FACT" as const, key });
const literal = (value: string | number | boolean | null) => ({ source: "LITERAL" as const, value });

/**
 * Default deficit rule set, expressed entirely as deterministic data.
 * This exact shape can later be persisted/versioned after shadow parity is
 * established; the evaluator itself will not need to change.
 */
export const DEFAULT_DEFICIT_RULES: readonly StructuredDecisionRule<DeficitRuleResult>[] = [
  {
    id: "deficit.active_exemption",
    version: 1,
    priority: 100,
    when: {
      logic: "AND",
      conditions: [{ left: fact("has_active_exemption"), operator: "IS_TRUE" }],
    },
    result: { state: "EXEMPTED", reasonCode: "ACTIVE_POLICY_EXEMPTION" },
  },
  {
    id: "deficit.policy_disabled",
    version: 1,
    priority: 90,
    when: {
      logic: "AND",
      conditions: [{ left: fact("deficit_policy_enabled"), operator: "IS_FALSE" }],
    },
    result: { state: "AVAILABLE", reasonCode: "POLICY_DISABLED" },
  },
  {
    id: "deficit.within_threshold",
    version: 1,
    priority: 80,
    when: {
      logic: "AND",
      conditions: [
        {
          left: fact("deficit_amount"),
          operator: "<=",
          right: fact("deficit_threshold"),
        },
      ],
    },
    result: { state: "AVAILABLE", reasonCode: "WITHIN_DEFICIT_THRESHOLD" },
  },
  {
    id: "deficit.grace_expired",
    version: 1,
    priority: 70,
    when: {
      logic: "AND",
      conditions: [
        { left: fact("has_due_anchor"), operator: "IS_TRUE" },
        {
          left: fact("days_overdue"),
          operator: ">",
          right: fact("grace_period_days"),
        },
      ],
    },
    result: { state: "RESTRICTED", reasonCode: "DEFICIT_GRACE_EXPIRED" },
  },
  {
    id: "deficit.grace_active",
    version: 1,
    priority: 60,
    when: {
      logic: "AND",
      conditions: [
        { left: fact("has_due_anchor"), operator: "IS_TRUE" },
        {
          left: fact("deficit_amount"),
          operator: ">",
          right: fact("deficit_threshold"),
        },
      ],
    },
    result: { state: "GRACE_PERIOD", reasonCode: "DEFICIT_GRACE_ACTIVE" },
  },
  {
    id: "deficit.grace_started",
    version: 1,
    priority: 50,
    when: {
      logic: "AND",
      conditions: [
        {
          left: fact("deficit_amount"),
          operator: ">",
          right: fact("deficit_threshold"),
        },
      ],
    },
    result: { state: "GRACE_PERIOD", reasonCode: "DEFICIT_GRACE_STARTED" },
  },
] as const;

function graceUntil(context: DeficitPolicyContext): Date {
  const anchor = context.oldestUnsettledDueAt ?? context.now;
  return new Date(anchor.getTime() + context.gracePeriodDays * DAY_MS);
}

function buildFacts(context: DeficitPolicyContext): RuleFacts {
  return {
    has_active_exemption: context.hasActiveExemption,
    deficit_policy_enabled: context.deficitPolicyEnabled,
    deficit_amount: Math.max(0, -context.availableMinor),
    deficit_threshold: context.deficitThresholdMinor,
    has_due_anchor: context.oldestUnsettledDueAt !== null,
    days_overdue: context.oldestUnsettledDueAt
      ? (context.now.getTime() - context.oldestUnsettledDueAt.getTime()) / DAY_MS
      : 0,
    grace_period_days: context.gracePeriodDays,
  };
}

function explanationFor(reasonCode: string): string {
  switch (reasonCode) {
    case "ACTIVE_POLICY_EXEMPTION":
      return "An active deficit-restriction exemption applies to this resident.";
    case "POLICY_DISABLED":
      return "Deficit restriction is disabled for this institution.";
    case "WITHIN_DEFICIT_THRESHOLD":
      return "The resident's available funds are within the configured deficit threshold.";
    case "DEFICIT_GRACE_EXPIRED":
      return "The resident is beyond the deficit threshold and the configured grace period has expired.";
    case "DEFICIT_GRACE_ACTIVE":
      return "The resident is beyond the deficit threshold but remains inside the grace period.";
    case "DEFICIT_GRACE_STARTED":
      return "The resident is beyond the deficit threshold; the grace period starts now because no unsettled bill due date is available.";
    default:
      return "The deficit policy produced a decision.";
  }
}

/** Pure, explainable deficit-policy decision. */
export function evaluateDeficitPolicy(context: DeficitPolicyContext): DeficitPolicyDecision {
  const evaluation = evaluateFirstMatchingRule(DEFAULT_DEFICIT_RULES, buildFacts(context));
  const state = evaluation.result.state;

  return {
    state,
    reasonCode: evaluation.result.reasonCode,
    explanation: explanationFor(evaluation.result.reasonCode),
    ruleVersionId: evaluation.ruleVersionId,
    graceUntilIso:
      state === "EXEMPTED"
        ? context.activeExemptionExpiresAt?.toISOString() ?? null
        : state === "GRACE_PERIOD" || state === "RESTRICTED"
          ? graceUntil(context).toISOString()
          : null,
  };
}

/**
 * Shadow comparison helper. State and grace timestamp are both meaningful
 * outputs; reason/rule metadata have no legacy equivalent and are intentionally
 * excluded from parity comparison.
 */
export function deficitPolicyMatchesLegacy(
  decision: DeficitPolicyDecision,
  legacy: { state: DeficitPolicyState; graceUntilIso: string | null }
): boolean {
  return decision.state === legacy.state && decision.graceUntilIso === legacy.graceUntilIso;
}
