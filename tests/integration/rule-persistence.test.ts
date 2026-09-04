import { describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { DEFAULT_DEFICIT_RULES } from "@/lib/domain/policy/deficit-policy";
import {
  activateDeficitRuleVersion,
  createDeficitRuleDraft,
  resolveActiveDeficitRuleSet,
  simulateDeficitRuleSet,
} from "@/lib/domain/rules/deficit-rules";
import { residentFundsSummary } from "@/lib/domain/funds";
import { invalidateInstitutionCache } from "@/lib/institution";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function cloneDefault(): any[] {
  return JSON.parse(JSON.stringify(DEFAULT_DEFICIT_RULES));
}

async function createInstitution() {
  return db.institution.create({
    data: {
      name: unique("Rule Integration Mess"),
      settings: {
        create: {
          deficitThresholdMinor: 1000,
          gracePeriodDays: 0,
          restrictMealsOnDeficit: true,
          deficitPolicyEnabled: true,
        },
      },
    },
  });
}

async function createResidentWithOverdueBill(institutionId: string) {
  const resident = await db.user.create({
    data: {
      institutionId,
      role: "RESIDENT",
      status: "ACTIVE",
      email: `${unique("rule-resident")}@example.test`,
      passwordHash: "integration-test-only",
      membershipEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const period = await db.billingPeriod.create({
    data: {
      institutionId,
      year: 2026,
      month: 9,
      status: "BILLED",
      billedAt: new Date(),
    },
  });

  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId,
      billingPeriodId: period.id,
      payloadJson: "{}",
      checksum: unique("rule-snapshot"),
      residentCount: 1,
      residentMealCount: 0,
      guestMealCount: 0,
      eligibleExpensesMinor: 0,
      approvedPaymentsMinor: 0,
      mealChargeMinor: 0,
    },
  });

  await db.bill.create({
    data: {
      institutionId,
      residentId: resident.id,
      billingPeriodId: period.id,
      snapshotId: snapshot.id,
      billNumber: unique("BILL-RULE"),
      subtotalMinor: 5000,
      totalDueMinor: 5000,
      dueDate: new Date(Date.now() - 2 * 86_400_000),
      status: "OVERDUE",
    },
  });

  return resident;
}

describe("versioned deficit rule persistence", () => {
  test("draft → simulate → checksum-guarded shadow activation preserves legacy authority", async () => {
    const institution = await createInstitution();
    const adminUserId = unique("admin");

    const v1 = await createDeficitRuleDraft({
      institutionId: institution.id,
      adminUserId,
      requestId: unique("req-v1"),
      rules: cloneDefault(),
      reason: "Establish the versioned default deficit policy.",
    });

    expect(v1.version).toBe(1);
    expect(v1.status).toBe("DRAFT");
    expect(v1.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(v1.rules.every((rule) => rule.version === 1)).toBe(true);

    const context = {
      availableMinor: -5000,
      deficitThresholdMinor: 1000,
      gracePeriodDays: 0,
      deficitPolicyEnabled: true,
      oldestUnsettledDueAt: new Date(Date.now() - 2 * 86_400_000),
      activeExemptionExpiresAt: null,
      hasActiveExemption: false,
      now: new Date(),
    };

    const simulationV1 = await simulateDeficitRuleSet({
      institutionId: institution.id,
      versionId: v1.id,
      context,
    });
    expect(simulationV1.candidate.checksum).toBe(v1.checksum);
    expect(simulationV1.candidate.decision.state).toBe("RESTRICTED");
    expect(simulationV1.current.source).toBe("DEFAULT");
    expect(simulationV1.changed).toBe(false);

    await expect(
      activateDeficitRuleVersion({
        institutionId: institution.id,
        adminUserId,
        requestId: unique("req-bad-checksum"),
        versionId: v1.id,
        expectedChecksum: "0".repeat(64),
        confirmImpact: true,
        reason: "Negative stale-checksum integration assertion.",
      })
    ).rejects.toThrow("changed after simulation");

    const stillDraft = await db.ruleVersion.findUniqueOrThrow({ where: { id: v1.id } });
    expect(stillDraft.status).toBe("DRAFT");

    const activeV1 = await activateDeficitRuleVersion({
      institutionId: institution.id,
      adminUserId,
      requestId: unique("req-activate-v1"),
      versionId: v1.id,
      expectedChecksum: simulationV1.candidate.checksum,
      confirmImpact: true,
      reason: "Activate the baseline policy for shadow comparison.",
    });
    expect(activeV1.status).toBe("ACTIVE");
    expect(activeV1.effectiveFrom).not.toBeNull();

    const changedRules = cloneDefault();
    const expiredRule = changedRules.find((rule) => rule.id === "deficit.grace_expired");
    expiredRule.result = {
      state: "AVAILABLE",
      reasonCode: "CUSTOM_GRACE_EXPIRED_ALLOW",
    };

    const v2 = await createDeficitRuleDraft({
      institutionId: institution.id,
      adminUserId,
      requestId: unique("req-v2"),
      rules: changedRules,
      reason: "Test an intentional policy change while remaining in shadow mode.",
    });
    expect(v2.version).toBe(2);
    expect(v2.rules.every((rule) => rule.version === 2)).toBe(true);

    const simulationV2 = await simulateDeficitRuleSet({
      institutionId: institution.id,
      versionId: v2.id,
      context,
    });
    expect(simulationV2.current.source).toBe("PERSISTED");
    expect(simulationV2.current.version).toBe(1);
    expect(simulationV2.current.decision.state).toBe("RESTRICTED");
    expect(simulationV2.candidate.decision.state).toBe("AVAILABLE");
    expect(simulationV2.changed).toBe(true);

    const activeV2 = await activateDeficitRuleVersion({
      institutionId: institution.id,
      adminUserId,
      requestId: unique("req-activate-v2"),
      versionId: v2.id,
      expectedChecksum: simulationV2.candidate.checksum,
      confirmImpact: true,
      reason: "Activate changed rule only for shadow mismatch observation.",
    });
    expect(activeV2.status).toBe("ACTIVE");

    const historicalV1 = await db.ruleVersion.findUniqueOrThrow({ where: { id: v1.id } });
    expect(historicalV1.status).toBe("HISTORICAL");
    expect(historicalV1.effectiveUntil).not.toBeNull();

    const resolved = await resolveActiveDeficitRuleSet(institution.id);
    expect(resolved.source).toBe("PERSISTED");
    expect(resolved.version).toBe(2);
    expect(resolved.policyVersionId).toBe(v2.id);

    const resident = await createResidentWithOverdueBill(institution.id);
    invalidateInstitutionCache();
    const funds = await residentFundsSummary(resident.id);

    // The active persisted rule says AVAILABLE for expired grace, but this PR is
    // intentionally shadow-only. Legacy funds logic must still win.
    expect(funds.policyState).toBe("RESTRICTED");

    const audits = await db.auditEvent.findMany({
      where: {
        institutionId: institution.id,
        entityType: "RULE_VERSION",
      },
    });
    expect(audits.some((event) => event.action === "RULE_VERSION_CREATED")).toBe(true);
    expect(audits.some((event) => event.action === "RULE_VERSION_ACTIVATED_SHADOW")).toBe(true);
  });
});
