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
import { evaluateFirstMatchingRule, type DecisionRule } from "@/lib/domain/rules/engine";

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

type RuleResult = Omit<DeficitPolicyDecision, "ruleVersionId">;

const DAY_MS = 86_400_000;

function graceUntil(context: DeficitPolicyContext): Date {
  const anchor = context.oldestUnsettledDueAt ?? context.now;
  return new Date(anchor.getTime() + context.gracePeriodDays * DAY_MS);
}

const DEFICIT_RULES: readonly DecisionRule<DeficitPolicyContext, RuleResult>[] = [
  {
    id: "deficit.active_exemption",
    version: 1,
    priority: 100,
    when: (ctx) => ctx.hasActiveExemption,
    decide: (ctx) => ({
      state: "EXEMPTED",
      reasonCode: "ACTIVE_POLICY_EXEMPTION",
      explanation: "An active deficit-restriction exemption applies to this resident.",
      graceUntilIso: ctx.activeExemptionExpiresAt?.toISOString() ?? null,
    }),
  },
  {
    id: "deficit.policy_disabled",
    version: 1,
    priority: 90,
    when: (ctx) => !ctx.deficitPolicyEnabled,
    decide: () => ({
      state: "AVAILABLE",
      reasonCode: "POLICY_DISABLED",
      explanation: "Deficit restriction is disabled for this institution.",
      graceUntilIso: null,
    }),
  },
  {
    id: "deficit.within_threshold",
    version: 1,
    priority: 80,
    when: (ctx) => ctx.availableMinor >= -ctx.deficitThresholdMinor,
    decide: () => ({
      state: "AVAILABLE",
      reasonCode: "WITHIN_DEFICIT_THRESHOLD",
      explanation: "The resident's available funds are within the configured deficit threshold.",
      graceUntilIso: null,
    }),
  },
  {
    id: "deficit.grace_expired",
    version: 1,
    priority: 70,
    when: (ctx) => ctx.oldestUnsettledDueAt !== null && graceUntil(ctx).getTime() < ctx.now.getTime(),
    decide: (ctx) => ({
      state: "RESTRICTED",
      reasonCode: "DEFICIT_GRACE_EXPIRED",
      explanation: "The resident is beyond the deficit threshold and the configured grace period has expired.",
      graceUntilIso: graceUntil(ctx).toISOString(),
    }),
  },
  {
    id: "deficit.grace_active",
    version: 1,
    priority: 60,
    when: () => true,
    decide: (ctx) => ({
      state: "GRACE_PERIOD",
      reasonCode: ctx.oldestUnsettledDueAt ? "DEFICIT_GRACE_ACTIVE" : "DEFICIT_GRACE_STARTED",
      explanation: ctx.oldestUnsettledDueAt
        ? "The resident is beyond the deficit threshold but remains inside the grace period."
        : "The resident is beyond the deficit threshold; the grace period starts now because no unsettled bill due date is available.",
      graceUntilIso: graceUntil(ctx).toISOString(),
    }),
  },
] as const;

/** Pure, explainable deficit-policy decision. */
export function evaluateDeficitPolicy(context: DeficitPolicyContext): DeficitPolicyDecision {
  const evaluation = evaluateFirstMatchingRule(DEFICIT_RULES, context);
  return {
    ...evaluation.result,
    ruleVersionId: evaluation.ruleVersionId,
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
