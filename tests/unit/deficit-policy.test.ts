import { describe, expect, test } from "bun:test";
import { evaluateFirstMatchingRule } from "@/lib/domain/rules/engine";
import {
  deficitPolicyMatchesLegacy,
  evaluateDeficitPolicy,
  type DeficitPolicyContext,
} from "@/lib/domain/policy/deficit-policy";

const NOW = new Date("2026-09-05T00:00:00.000Z");

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

describe("minimal Rule Engine", () => {
  test("highest priority matching rule wins deterministically", () => {
    const result = evaluateFirstMatchingRule(
      [
        { id: "low", version: 1, priority: 10, when: () => true, decide: () => "low" },
        { id: "high", version: 2, priority: 20, when: () => true, decide: () => "high" },
      ],
      {}
    );

    expect(result.result).toBe("high");
    expect(result.ruleVersionId).toBe("high@v2");
  });

  test("no implicit default is invented when no rule matches", () => {
    expect(() =>
      evaluateFirstMatchingRule(
        [{ id: "never", version: 1, priority: 1, when: () => false, decide: () => "x" }],
        {}
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
