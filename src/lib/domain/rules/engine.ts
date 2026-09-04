/**
 * MINIMAL RULE ENGINE — deliberately small and deterministic.
 *
 * This is not a generic automation platform. It evaluates an ordered list of
 * typed rules and returns the first match together with the exact rule version
 * that produced the decision. No eval, dynamic code, side effects, or database
 * access belongs here.
 */

export type RuleVersionRef = {
  id: string;
  version: number;
};

export type DecisionRule<Context, Result> = RuleVersionRef & {
  priority: number;
  when: (context: Context) => boolean;
  decide: (context: Context) => Result;
};

export type RuleEvaluation<Result> = {
  result: Result;
  ruleVersionId: string;
};

/**
 * Highest priority wins. Equal priorities preserve declaration order.
 * Throws loudly when no rule matches: every policy must have an explicit
 * fallback rather than silently inventing a default.
 */
export function evaluateFirstMatchingRule<Context, Result>(
  rules: readonly DecisionRule<Context, Result>[],
  context: Context
): RuleEvaluation<Result> {
  const ordered = rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);

  for (const { rule } of ordered) {
    if (rule.when(context)) {
      return {
        result: rule.decide(context),
        ruleVersionId: `${rule.id}@v${rule.version}`,
      };
    }
  }

  throw new Error("RULE_ENGINE_NO_MATCH");
}
