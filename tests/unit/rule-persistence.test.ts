import { describe, expect, test } from "bun:test";
import { DEFAULT_DEFICIT_RULES } from "@/lib/domain/policy/deficit-policy";
import {
  parseDeficitRuleSet,
  validateDeficitRuleCoverage,
} from "@/lib/domain/rules/deficit-rules";

function cloneDefault(): any[] {
  return JSON.parse(JSON.stringify(DEFAULT_DEFICIT_RULES));
}

describe("persisted deficit rule validation", () => {
  test("accepts the built-in structured deficit rule set", () => {
    const parsed = parseDeficitRuleSet(cloneDefault());
    expect(parsed).toHaveLength(DEFAULT_DEFICIT_RULES.length);
    expect(() => validateDeficitRuleCoverage(parsed)).not.toThrow();
  });

  test("rejects unknown executable-looking fields instead of stripping them", () => {
    const rules = cloneDefault();
    rules[0].javascript = "return true";

    expect(() => parseDeficitRuleSet(rules)).toThrow();
  });

  test("rejects malformed operator payloads", () => {
    const rules = cloneDefault();
    rules[2].when.conditions[0] = {
      left: { source: "FACT", key: "deficit_amount" },
      operator: "BETWEEN",
      values: [{ source: "LITERAL", value: 1000 }],
    };

    expect(() => parseDeficitRuleSet(rules)).toThrow();
  });

  test("rejects duplicate rule ids", () => {
    const rules = cloneDefault();
    rules[1].id = rules[0].id;

    expect(() => parseDeficitRuleSet(rules)).toThrow("Duplicate rule id");
  });

  test("coverage validation rejects a rule set with an obvious decision hole", () => {
    const rules = cloneDefault().filter((rule) => rule.id === "deficit.active_exemption");
    const parsed = parseDeficitRuleSet(rules);

    expect(() => validateDeficitRuleCoverage(parsed)).toThrow("does not cover");
  });
});
