import { describe, expect, test } from "bun:test";
import {
  evaluateCondition,
  evaluateFirstMatchingRule,
  evaluateGroup,
  type RuleCondition,
} from "@/lib/domain/rules/engine";
import {
  deficitPolicyMatchesLegacy,
  evaluateDeficitPolicy,
  type DeficitPolicyContext,
} from "@/lib/domain/policy/deficit-policy";

const NOW = new Date("2026-09-05T00:00:00.000Z");
const fact = (key: string) => ({ source: "FACT" as const, key });
const literal = (value: string | number | boolean | null) => ({ source: "LITERAL" as const, value });

function context(overrides: Partial<DeficitPolicyContext> = {}): DeficitPolicyContext {
  return {
    availableMinor: 0,
    deficitThresholdMinor: 100000,
    gracePeriodDays: 7,
    deficitPolicyEnabled: true,
    oldestUnsettledDueAt: null,
    activeExemptionExpiresAt: null,
    hasActiveExemption: false,
    now: NOW,
    ...overrides,
  };
}

describe("minimal structured Rule Engine", () => {
  const facts = {
    amount: 8,
    threshold: 7,
    status: "ACTIVE",
    enabled: true,
    disabled: false,
  };

  test("supports the initial deterministic operator set", () => {
    const conditions: RuleCondition[] = [
      { left: fact("status"), operator: "==", right: literal("ACTIVE") },
      { left: fact("status"), operator: "!=", right: literal("BLOCKED") },
      { left: fact("amount"), operator: ">", right: fact("threshold") },
      { left: fact("amount"), operator: ">=", right: literal(8) },
      { left: fact("threshold"), operator: "<", right: fact("amount") },
      { left: fact("threshold"), operator: "<=", right: literal(7) },
      { left: fact("status"), operator: "IN", values: [literal("ACTIVE"), literal("PENDING")] },
      { left: fact("amount"), operator: "BETWEEN", values: [literal(5), literal(10)] },
      { left: fact("enabled"), operator: "IS_TRUE" },
      { left: fact("disabled"), operator: "IS_FALSE" },
    ];

    for (const condition of conditions) {
      expect(evaluateCondition(condition, facts).matched).toBe(true);
    }
  });

  test("supports AND and OR grouping without executable rule code", () => {
    const andGroup = evaluateGroup(
      {
        logic: "AND",
        conditions: [
          { left: fact("amount"), operator: ">", right: fact("threshold") },
          { left: fact("enabled"), operator: "IS_TRUE" },
        ],
      },
      facts
    );
    const orGroup = evaluateGroup(
      {
        logic: "OR",
        conditions: [
          { left: fact("status"), operator: "==", right: literal("BLOCKED") },
          { left: fact("enabled"), operator: "IS_TRUE" },
        ],
      },
      facts
    );

    expect(andGroup.matched).toBe(true);
    expect(orGroup.matched).toBe(true);
  });

  test("highest priority matching structured rule wins deterministically", () => {
    const result = evaluateFirstMatchingRule(
      [
        {
          id: "low",
          version: 1,
          priority: 10,
          when: { logic: "AND", conditions: [{ left: fact("enabled"), operator: "IS_TRUE" }] },
          result: "low",
        },
        {
          id: "high",
          version: 2,
          priority: 20,
          when: { logic: "AND", conditions: [{ left: fact("enabled"), operator: "IS_TRUE" }] },
          result: "high",
        },
      ],
      facts
    );

    expect(result.result).toBe("high");
    expect(result.ruleVersionId).toBe("high@v2");
    expect(result.trace.every((step) => step.matched)).toBe(true);
  });

  test("unknown facts and missing fallbacks fail loudly", () => {
    expect(() =>
      evaluateCondition({ left: fact("missing"), operator: "IS_TRUE" }, facts)
    ).toThrow("RULE_ENGINE_UNKNOWN_FACT:missing");

    expect(() =>
      evaluateFirstMatchingRule(
        [
          {
            id: "never",
            version: 1,
            priority: 1,
            when: { logic: "AND", conditions: [{ left: fact("disabled"), operator: "IS_TRUE" }] },
            result: "x",
          },
        ],
        facts
      )
    ).toThrow("RULE_ENGINE_NO_MATCH");
  });
});

describe("DeficitPolicyService", () => {
  test("active exemption has highest precedence", () => {
    const expires = new Date("2026-09-10T00:00:00.000Z");
    const decision = evaluateDeficitPolicy(
      context({
        availableMinor: -500000,
        hasActiveExemption: true,
        activeExemptionExpiresAt: expires,
        oldestUnsettledDueAt: new Date("2026-08-01T00:00:00.000Z"),
      })
    );

    expect(decision.state).toBe("EXEMPTED");
    expect(decision.reasonCode).toBe("ACTIVE_POLICY_EXEMPTION");
    expect(decision.graceUntilIso).toBe(expires.toISOString());
    expect(decision.ruleVersionId).toBe("deficit.active_exemption@v1");
  });

  test("disabled policy stays available even beyond threshold", () => {
    const decision = evaluateDeficitPolicy(
      context({ availableMinor: -500000, deficitPolicyEnabled: false })
    );

    expect(decision.state).toBe("AVAILABLE");
    expect(decision.reasonCode).toBe("POLICY_DISABLED");
  });

  test("exact threshold is AVAILABLE and one paise beyond enters grace", () => {
    const atThreshold = evaluateDeficitPolicy(
      context({ availableMinor: -100000, deficitThresholdMinor: 100000 })
    );
    const beyond = evaluateDeficitPolicy(
      context({ availableMinor: -100001, deficitThresholdMinor: 100000 })
    );

    expect(atThreshold.state).toBe("AVAILABLE");
    expect(beyond.state).toBe("GRACE_PERIOD");
    expect(beyond.reasonCode).toBe("DEFICIT_GRACE_STARTED");
    expect(beyond.graceUntilIso).toBe("2026-09-12T00:00:00.000Z");
  });

  test("oldest unsettled bill anchors an active grace period", () => {
    const decision = evaluateDeficitPolicy(
      context({
        availableMinor: -100001,
        gracePeriodDays: 7,
        oldestUnsettledDueAt: new Date("2026-09-01T00:00:00.000Z"),
      })
    );

    expect(decision.state).toBe("GRACE_PERIOD");
    expect(decision.reasonCode).toBe("DEFICIT_GRACE_ACTIVE");
    expect(decision.graceUntilIso).toBe("2026-09-08T00:00:00.000Z");
  });

  test("expired anchored grace becomes RESTRICTED", () => {
    const decision = evaluateDeficitPolicy(
      context({
        availableMinor: -100001,
        gracePeriodDays: 7,
        oldestUnsettledDueAt: new Date("2026-08-20T00:00:00.000Z"),
      })
    );

    expect(decision.state).toBe("RESTRICTED");
    expect(decision.reasonCode).toBe("DEFICIT_GRACE_EXPIRED");
    expect(decision.graceUntilIso).toBe("2026-08-27T00:00:00.000Z");
  });

  test("exact grace boundary remains in GRACE_PERIOD, matching legacy strict less-than behavior", () => {
    const decision = evaluateDeficitPolicy(
      context({
        availableMinor: -100001,
        gracePeriodDays: 7,
        oldestUnsettledDueAt: new Date("2026-08-29T00:00:00.000Z"),
      })
    );

    expect(decision.state).toBe("GRACE_PERIOD");
    expect(decision.graceUntilIso).toBe(NOW.toISOString());
  });

  test("shadow comparator checks both state and grace timestamp", () => {
    const decision = evaluateDeficitPolicy(
      context({ availableMinor: -100001, gracePeriodDays: 2 })
    );

    expect(
      deficitPolicyMatchesLegacy(decision, {
        state: "GRACE_PERIOD",
        graceUntilIso: "2026-09-07T00:00:00.000Z",
      })
    ).toBe(true);
    expect(
      deficitPolicyMatchesLegacy(decision, {
        state: "GRACE_PERIOD",
        graceUntilIso: "2026-09-08T00:00:00.000Z",
      })
    ).toBe(false);
  });
});
