/**
 * FUNDS read model (spec §42-44) — derived, never a mutable balance column.
 *
 * Authoritative definitions:
 *   creditsMinor        = Σ approved payments (Dr CASH / Cr RESIDENT_FUNDS)
 *   chargesMinor        = Σ effective charge of non-voided bills,
 *                         max(0, subtotal + immutable adjustments) per bill
 *   refundsIssuedMinor  = Σ COMPLETED ISSUE_REFUND refunds (cash returned to resident)
 *   carryForwardMinor   = Σ COMPLETED CARRY_FORWARD refunds — INFORMATIONAL ONLY:
 *                         the credit stays on the ledger for future bills, so it is
 *                         NOT subtracted from available (subtracting it would erase
 *                         money the resident actually paid — audit 9-c finding #2).
 *   availableMinor      = credits − charges − refundsIssued  (negative ⇒ deficit)
 *   amountToPayMinor    = Σ totalDue of unsettled bills (GENERATED|PARTIALLY_PAID|OVERDUE)
 *
 * Deficit policy: EXEMPTED (active exemption) → AVAILABLE (≥ −threshold) →
 * GRACE_PERIOD (below −threshold, grace not expired) → RESTRICTED (past grace).
 * Grace anchor = oldest unsettled bill dueDate + gracePeriodDays (documented
 * decision: PENDING payments do not add funds until approved; UI surfaces them).
 *
 * SHADOW MODE: the legacy policy below remains authoritative. The focused
 * DeficitPolicyService evaluates the same captured facts using the active
 * persisted shadow rule version when one exists, otherwise the built-in rules.
 * Load/validation failures fail safe to the built-in rules. Only mismatches are
 * logged; no meal or funds behavior is changed.
 */
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import {
  deficitPolicyMatchesLegacy,
  evaluateDeficitPolicy,
  evaluateDeficitPolicyWithRules,
  type DeficitPolicyState,
} from "@/lib/domain/policy/deficit-policy";
import { resolveActiveDeficitRuleSet } from "@/lib/domain/rules/deficit-rules";
import { effectiveBillStatus } from "@/lib/domain/bill-status";

export type { DeficitPolicyState } from "@/lib/domain/policy/deficit-policy";

export type ResidentFundsSummary = {
  residentId: string;
  creditsMinor: number;
  pendingPaymentsMinor: number;
  chargesMinor: number;
  refundsIssuedMinor: number;
  carryForwardMinor: number;
  availableMinor: number;
  amountToPayMinor: number;
  deficitMinor: number;
  policyState: DeficitPolicyState;
  graceUntilIso: string | null;
  thresholdMinor: number;
};

const UNSETTLED = ["GENERATED", "PARTIALLY_PAID", "OVERDUE"];

export async function residentFundsSummary(residentId: string, client: any = db): Promise<ResidentFundsSummary> {
  const resident = await client.user.findUnique({ where: { id: residentId } });
  if (!resident) throw new Error("RESIDENT_NOT_FOUND");
  const inst = await getInstitution(resident.institutionId);
  const threshold = inst?.settings.deficitThresholdMinor ?? 100000;
  const graceDays = inst?.settings.gracePeriodDays ?? 7;

  const [
    approvedAgg,
    pendingAgg,
    billRows,
    refundsIssuedAgg,
    carryForwardAgg,
    activeExemption,
  ] = await Promise.all([
    client.payment.aggregate({
      where: { residentId, status: "APPROVED" },
      _sum: { amountMinor: true },
    }),
    client.payment.aggregate({ where: { residentId, status: "PENDING" }, _sum: { amountMinor: true } }),
    client.bill.findMany({
      where: { residentId, status: { not: "VOIDED" } },
      select: {
        subtotalMinor: true,
        adjustmentsMinor: true,
        totalDueMinor: true,
        dueDate: true,
        status: true,
      },
    }),
    client.refund.aggregate({
      where: { residentId, status: "COMPLETED", mode: "ISSUE_REFUND" },
      _sum: { amountMinor: true },
    }),
    client.refund.aggregate({
      where: { residentId, status: "COMPLETED", mode: "CARRY_FORWARD" },
      _sum: { amountMinor: true },
    }),
    client.policyExemption.findFirst({
      where: {
        residentId,
        policyType: "DEFICIT_RESTRICTION",
        startsAt: { lte: new Date() },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }),
  ]);

  const creditsMinor = approvedAgg._sum.amountMinor ?? 0;
  const pendingPaymentsMinor = pendingAgg._sum.amountMinor ?? 0;
  const chargesMinor = billRows.reduce(
    (sum: number, bill: { subtotalMinor: number; adjustmentsMinor: number }) =>
      sum + Math.max(0, bill.subtotalMinor + bill.adjustmentsMinor),
    0
  );
  const refundsIssuedMinor = refundsIssuedAgg._sum.amountMinor ?? 0;
  const carryForwardMinor = carryForwardAgg._sum.amountMinor ?? 0;

  const unsettledBills = billRows
    .filter((bill: { status: string; totalDueMinor: number }) => UNSETTLED.includes(bill.status) && bill.totalDueMinor > 0)
    .sort((a: { dueDate: Date }, b: { dueDate: Date }) => a.dueDate.getTime() - b.dueDate.getTime());

  const availableMinor = creditsMinor - chargesMinor - refundsIssuedMinor;
  const amountToPayMinor = unsettledBills.reduce((s: number, b: { totalDueMinor: number }) => s + b.totalDueMinor, 0);
  const deficitMinor = Math.max(0, -availableMinor);

  // Legacy policy remains AUTHORITATIVE during shadow mode.
  // Capture one clock instant so the legacy and shadow decisions compare the
  // same grace boundary rather than differing by a few milliseconds.
  const policyNow = new Date();
  let policyState: DeficitPolicyState = "AVAILABLE";
  let graceUntilIso: string | null = null;
  if (activeExemption) {
    policyState = "EXEMPTED";
    graceUntilIso = activeExemption.expiresAt?.toISOString() ?? null;
  } else if (availableMinor < -threshold && inst?.settings.deficitPolicyEnabled) {
    const oldestDue = unsettledBills[0]?.dueDate ?? null;
    if (oldestDue) {
      const graceUntil = new Date(oldestDue.getTime() + graceDays * 24 * 60 * 60 * 1000);
      graceUntilIso = graceUntil.toISOString();
      policyState = graceUntil < policyNow ? "RESTRICTED" : "GRACE_PERIOD";
    } else {
      // Deficit with no bill anchor yet: grace window starts now.
      policyState = "GRACE_PERIOD";
      graceUntilIso = new Date(policyNow.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  const policyContext = {
    availableMinor,
    deficitThresholdMinor: threshold,
    gracePeriodDays: graceDays,
    deficitPolicyEnabled: Boolean(inst?.settings.deficitPolicyEnabled),
    oldestUnsettledDueAt: unsettledBills[0]?.dueDate ?? null,
    activeExemptionExpiresAt: activeExemption?.expiresAt ?? null,
    hasActiveExemption: Boolean(activeExemption),
    now: policyNow,
  };

  // New Rule Engine path — SHADOW ONLY. Persisted active shadow rules are used
  // when available. Any load/checksum/validation problem fails safe to the
  // built-in rule set and never changes authoritative behavior.
  let shadowDecision;
  let shadowPolicySource: "DEFAULT" | "PERSISTED" = "DEFAULT";
  let shadowPolicyVersionId: string | null = null;
  let shadowPolicyChecksum: string | null = null;
  try {
    const activeRuleSet = await resolveActiveDeficitRuleSet(resident.institutionId, client);
    shadowPolicySource = activeRuleSet.source;
    shadowPolicyVersionId = activeRuleSet.policyVersionId;
    shadowPolicyChecksum = activeRuleSet.checksum;
    shadowDecision = evaluateDeficitPolicyWithRules(policyContext, activeRuleSet.rules);
  } catch (error) {
    console.error("[deficit-policy-shadow-load-failed]", {
      institutionId: resident.institutionId,
      residentId,
      error: error instanceof Error ? error.message : "unknown error",
    });
    shadowDecision = evaluateDeficitPolicy(policyContext);
  }

  if (!deficitPolicyMatchesLegacy(shadowDecision, { state: policyState, graceUntilIso })) {
    console.warn("[deficit-policy-shadow-mismatch]", {
      institutionId: resident.institutionId,
      residentId,
      legacyState: policyState,
      shadowState: shadowDecision.state,
      legacyGraceUntil: graceUntilIso,
      shadowGraceUntil: shadowDecision.graceUntilIso,
      shadowRuleVersionId: shadowDecision.ruleVersionId,
      shadowPolicySource,
      shadowPolicyVersionId,
      shadowPolicyChecksum,
    });
  }

  return {
    residentId,
    creditsMinor,
    pendingPaymentsMinor,
    chargesMinor,
    refundsIssuedMinor,
    carryForwardMinor,
    availableMinor,
    amountToPayMinor,
    deficitMinor,
    policyState,
    graceUntilIso,
    thresholdMinor: threshold,
  };
}

/** Restriction flag used by the meal engine (§28 step: financial restriction). */
export async function isMealRestricted(residentId: string, client: any = db): Promise<boolean> {
  const summary = await residentFundsSummary(residentId, client);
  return summary.policyState === "RESTRICTED";
}

// ---------------------------------------------------------------------------
// BILL SETTLEMENT — deterministic FIFO recompute from the approved-payment pool
// (audit 9-a finding #5 / 9-c finding #5). Bills keep settling AFTER a period
// is billed: payments approved later (or voided) re-run the allocation.
// ---------------------------------------------------------------------------

export type BillApplication = {
  billId: string;
  billNumber: string;
  appliedMinor: number;
  status: string;
  totalDueMinor: number;
};

/** Derive a bill's status column from its due amount and due date. */
function deriveBillStatus(
  bill: { dueDate: Date },
  totalDueMinor: number,
  appliedMinor: number,
  timeZone: string,
  now: Date
): string {
  return effectiveBillStatus(
    {
      status: "GENERATED",
      dueDate: bill.dueDate,
      totalDueMinor,
      paymentsMinor: appliedMinor,
    },
    timeZone,
    now
  );
}

/**
 * Recompute the resident's ENTIRE bill settlement from first principles:
 * pool = Σ APPROVED payments (voided/pending excluded), allocated FIFO to the
 * resident's live bills (oldest due first, each capped at subtotal+adjustments).
 * Excess pool stays unapplied (= the resident's available credit).
 *
 * Why a full recompute instead of incremental apply/un-apply: a payment's
 * exact attribution to bills isn't stored, and approve/void/refund can each
 * change the pool — recomputing is idempotent, race-safe to re-run, and can
 * never drift (no per-event arithmetic to get wrong).
 * Read-model only — money journals live on the ledger. Must run inside the
 * caller's transaction.
 */
export async function recomputeBillSettlement(
  client: any,
  residentId: string
): Promise<{ poolMinor: number; changedBills: BillApplication[]; unappliedMinor: number }> {
  const resident = await client.user.findUnique({
    where: { id: residentId },
    select: { institutionId: true },
  });
  if (!resident) throw new Error("RESIDENT_NOT_FOUND");
  const institution = await getInstitution(resident.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const statusNow = new Date();

  const poolAgg = await client.payment.aggregate({
    where: { residentId, status: "APPROVED" },
    _sum: { amountMinor: true },
  });
  const poolMinor = poolAgg._sum.amountMinor ?? 0;

  const bills = await client.bill.findMany({
    where: { residentId, status: { not: "VOIDED" } },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });

  let remaining = poolMinor;
  const changedBills: BillApplication[] = [];
  for (const bill of bills) {
    const capacity = Math.max(0, bill.subtotalMinor + bill.adjustmentsMinor);
    const appliedMinor = Math.min(remaining, capacity);
    const totalDueMinor = Math.max(0, capacity - appliedMinor);
    const status = deriveBillStatus(bill, totalDueMinor, appliedMinor, timeZone, statusNow);
    if (appliedMinor !== bill.paymentsMinor || totalDueMinor !== bill.totalDueMinor || status !== bill.status) {
      await client.bill.update({
        where: { id: bill.id },
        data: { paymentsMinor: appliedMinor, totalDueMinor, status },
      });
      changedBills.push({ billId: bill.id, billNumber: bill.billNumber, appliedMinor, status, totalDueMinor });
    }
    remaining -= appliedMinor;
  }
  return { poolMinor, changedBills, unappliedMinor: remaining };
}
