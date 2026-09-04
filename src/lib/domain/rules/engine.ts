/**
 * MINIMAL STRUCTURED RULE ENGINE — deliberately small and deterministic.
 *
 * Rules are data, not executable code. Conditions can reference named facts or
 * literal values and use only the small operator set required by BoardOps.
 * No eval, JavaScript snippets, SQL, shell, arbitrary functions, side effects,
 * or database access belongs here.
 */

export type RuleScalar = string | number | boolean | null;
export type RuleFacts = Record<string, RuleScalar>;

export type RuleOperator =
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "IN"
  | "BETWEEN"
  | "IS_TRUE"
  | "IS_FALSE";

export type RuleOperand =
  | { source: "FACT"; key: string }
  | { source: "LITERAL"; value: RuleScalar };

export type RuleCondition = {
  left: RuleOperand;
  operator: RuleOperator;
  /** Used by ==, !=, >, >=, <, <=. */
  right?: RuleOperand;
  /** Used by IN (1+) and BETWEEN (exactly 2). */
  values?: readonly RuleOperand[];
};

export type RuleGroup = {
  logic: "AND" | "OR";
  conditions: readonly RuleCondition[];
};

export type RuleVersionRef = {
  id: string;
  version: number;
};

export type StructuredDecisionRule<Result> = RuleVersionRef & {
  priority: number;
  when: RuleGroup;
  result: Result;
};

export type RuleConditionTrace = {
  condition: RuleCondition;
  leftValue: RuleScalar;
  rightValue?: RuleScalar;
  listValues?: RuleScalar[];
  matched: boolean;
};

export type RuleEvaluation<Result> = {
  result: Result;
  ruleVersionId: string;
  trace: RuleConditionTrace[];
};

function resolveOperand(operand: RuleOperand, facts: RuleFacts): RuleScalar {
  if (operand.source === "LITERAL") return operand.value;
  if (!Object.prototype.hasOwnProperty.call(facts, operand.key)) {
    throw new Error(`RULE_ENGINE_UNKNOWN_FACT:${operand.key}`);
  }
  return facts[operand.key];
}

function requireRight(condition: RuleCondition, facts: RuleFacts): RuleScalar {
  if (!condition.right) throw new Error(`RULE_ENGINE_RIGHT_OPERAND_REQUIRED:${condition.operator}`);
  return resolveOperand(condition.right, facts);
}

function requireNumbers(left: RuleScalar, right: RuleScalar, operator: RuleOperator): [number, number] {
  if (typeof left !== "number" || typeof right !== "number" || !Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error(`RULE_ENGINE_NUMERIC_OPERANDS_REQUIRED:${operator}`);
  }
  return [left, right];
}

export function evaluateCondition(condition: RuleCondition, facts: RuleFacts): RuleConditionTrace {
  const leftValue = resolveOperand(condition.left, facts);
  let rightValue: RuleScalar | undefined;
  let listValues: RuleScalar[] | undefined;
  let matched = false;

  switch (condition.operator) {
    case "==":
      rightValue = requireRight(condition, facts);
      matched = leftValue === rightValue;
      break;
    case "!=":
      rightValue = requireRight(condition, facts);
      matched = leftValue !== rightValue;
      break;
    case ">": {
      rightValue = requireRight(condition, facts);
      const [left, right] = requireNumbers(leftValue, rightValue, condition.operator);
      matched = left > right;
      break;
    }
    case ">=": {
      rightValue = requireRight(condition, facts);
      const [left, right] = requireNumbers(leftValue, rightValue, condition.operator);
      matched = left >= right;
      break;
    }
    case "<": {
      rightValue = requireRight(condition, facts);
      const [left, right] = requireNumbers(leftValue, rightValue, condition.operator);
      matched = left < right;
      break;
    }
    case "<=": {
      rightValue = requireRight(condition, facts);
      const [left, right] = requireNumbers(leftValue, rightValue, condition.operator);
      matched = left <= right;
      break;
    }
    case "IN": {
      if (!condition.values || condition.values.length === 0) {
        throw new Error("RULE_ENGINE_IN_VALUES_REQUIRED");
      }
      listValues = condition.values.map((operand) => resolveOperand(operand, facts));
      matched = listValues.some((value) => value === leftValue);
      break;
    }
    case "BETWEEN": {
      if (!condition.values || condition.values.length !== 2) {
        throw new Error("RULE_ENGINE_BETWEEN_TWO_VALUES_REQUIRED");
      }
      listValues = condition.values.map((operand) => resolveOperand(operand, facts));
      const [left, low] = requireNumbers(leftValue, listValues[0], condition.operator);
      const [, high] = requireNumbers(leftValue, listValues[1], condition.operator);
      matched = left >= low && left <= high;
      break;
    }
    case "IS_TRUE":
      matched = leftValue === true;
      break;
    case "IS_FALSE":
      matched = leftValue === false;
      break;
  }

  return { condition, leftValue, rightValue, listValues, matched };
}

export function evaluateGroup(group: RuleGroup, facts: RuleFacts): { matched: boolean; trace: RuleConditionTrace[] } {
  const trace = group.conditions.map((condition) => evaluateCondition(condition, facts));
  return {
    matched: group.logic === "AND" ? trace.every((item) => item.matched) : trace.some((item) => item.matched),
    trace,
  };
}

/**
 * Highest priority matching structured rule wins. Equal priorities preserve
 * declaration order. No hidden fallback is invented: callers must define one
 * explicitly if the domain requires it.
 */
export function evaluateFirstMatchingRule<Result>(
  rules: readonly StructuredDecisionRule<Result>[],
  facts: RuleFacts
): RuleEvaluation<Result> {
  const ordered = rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);

  for (const { rule } of ordered) {
    const evaluation = evaluateGroup(rule.when, facts);
    if (evaluation.matched) {
      return {
        result: rule.result,
        ruleVersionId: `${rule.id}@v${rule.version}`,
        trace: evaluation.trace,
      };
    }
  }

  throw new Error("RULE_ENGINE_NO_MATCH");
}
