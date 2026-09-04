import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";

export type BillingIntegrityCheck = {
  key: string;
  label: string;
  pass: boolean;
  detail?: string;
};

export type BillingPeriodIntegrity = {
  periodId: string;
  snapshotId: string | null;
  checksum: string | null;
  valid: boolean;
  checks: BillingIntegrityCheck[];
};

/** Canonical checksum algorithm used by billing generation and verification. */
export function billingSnapshotChecksum(payloadJson: string): string {
  const parsed = JSON.parse(payloadJson);
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

/**
 * Verify historical billing provenance without recalculating the bill from live
 * data. The immutable snapshot is the authority; these checks prove the period,
 * snapshot, bill rows, formula reference, and frozen aggregate counts still
 * agree with that recorded artifact.
 */
export async function verifyBillingPeriodIntegrity(
  periodId: string,
  client: any = db
): Promise<BillingPeriodIntegrity> {
  const period = await client.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);

  const [snapshot, bills] = await Promise.all([
    client.billingSnapshot.findUnique({ where: { billingPeriodId: periodId } }),
    client.bill.findMany({
      where: { billingPeriodId: periodId },
      select: {
        id: true,
        residentId: true,
        snapshotId: true,
        residentMealCount: true,
        guestMealCount: true,
        mealChargeMinor: true,
      },
    }),
  ]);

  const checks: BillingIntegrityCheck[] = [];
  const historical = period.status === "BILLED" || period.status === "REOPENED";
  checks.push({
    key: "snapshot_presence",
    label: historical ? "Historical period has an immutable snapshot" : "Open period has no stale billing snapshot",
    pass: historical ? Boolean(snapshot) : !snapshot,
    detail:
      historical && !snapshot
        ? "The period is historical but its billing snapshot is missing."
        : !historical && snapshot
          ? "An open period unexpectedly has a generated billing snapshot."
          : undefined,
  });

  checks.push({
    key: "bill_artifact_state",
    label: historical ? "Historical bill artifacts are present only for this period" : "Open period has no generated bills",
    pass: historical ? true : bills.length === 0,
    detail: !historical && bills.length > 0 ? `${bills.length} generated bill(s) exist on an open period.` : undefined,
  });

  if (!snapshot) {
    return {
      periodId,
      snapshotId: null,
      checksum: null,
      valid: checks.every((check) => check.pass),
      checks,
    };
  }

  checks.push({
    key: "snapshot_institution",
    label: "Snapshot belongs to the billing institution",
    pass: snapshot.institutionId === period.institutionId,
    detail: snapshot.institutionId !== period.institutionId ? "Snapshot institution does not match the period." : undefined,
  });

  let payload: any = null;
  try {
    payload = JSON.parse(snapshot.payloadJson);
    checks.push({ key: "snapshot_payload_json", label: "Snapshot payload is valid JSON", pass: true });
  } catch {
    checks.push({
      key: "snapshot_payload_json",
      label: "Snapshot payload is valid JSON",
      pass: false,
      detail: "The stored immutable payload cannot be parsed.",
    });
  }

  let computedChecksum: string | null = null;
  if (payload != null) {
    computedChecksum = billingSnapshotChecksum(snapshot.payloadJson);
  }
  checks.push({
    key: "snapshot_checksum",
    label: "Snapshot checksum matches its immutable payload",
    pass: computedChecksum != null && computedChecksum === snapshot.checksum,
    detail:
      computedChecksum != null && computedChecksum !== snapshot.checksum
        ? "Snapshot payload checksum mismatch — provenance may have been altered."
        : computedChecksum == null
          ? "Checksum cannot be verified because the payload is invalid."
          : undefined,
  });

  checks.push({
    key: "bill_snapshot_links",
    label: "Every generated bill points to this snapshot",
    pass: bills.every((bill: any) => bill.snapshotId === snapshot.id),
    detail: bills.some((bill: any) => bill.snapshotId !== snapshot.id)
      ? "One or more bills point to a different or missing snapshot."
      : undefined,
  });

  const uniqueResidents = new Set((bills as any[]).map((bill) => bill.residentId)).size;
  const residentMealCount = (bills as any[]).reduce((sum, bill) => sum + bill.residentMealCount, 0);
  const guestMealCount = (bills as any[]).reduce((sum, bill) => sum + bill.guestMealCount, 0);

  checks.push({
    key: "resident_count",
    label: "Snapshot resident count matches generated bills",
    pass: uniqueResidents === snapshot.residentCount,
    detail: uniqueResidents !== snapshot.residentCount
      ? `Bills cover ${uniqueResidents} resident(s), snapshot records ${snapshot.residentCount}.`
      : undefined,
  });
  checks.push({
    key: "resident_meal_count",
    label: "Snapshot resident meal count matches bill totals",
    pass: residentMealCount === snapshot.residentMealCount,
    detail: residentMealCount !== snapshot.residentMealCount
      ? `Bills total ${residentMealCount} resident meals, snapshot records ${snapshot.residentMealCount}.`
      : undefined,
  });
  checks.push({
    key: "guest_meal_count",
    label: "Snapshot guest meal count matches bill totals",
    pass: guestMealCount === snapshot.guestMealCount,
    detail: guestMealCount !== snapshot.guestMealCount
      ? `Bills total ${guestMealCount} guest meals, snapshot records ${snapshot.guestMealCount}.`
      : undefined,
  });

  if (period.mealChargeMinorSnapshot != null) {
    checks.push({
      key: "period_meal_charge",
      label: "Period frozen meal charge matches the snapshot",
      pass: period.mealChargeMinorSnapshot === snapshot.mealChargeMinor,
      detail:
        period.mealChargeMinorSnapshot !== snapshot.mealChargeMinor
          ? "Period and snapshot contain different frozen meal charges."
          : undefined,
    });
  }

  if (bills.length > 0) {
    checks.push({
      key: "bill_meal_charge",
      label: "Every bill uses the snapshot meal charge",
      pass: bills.every((bill: any) => bill.mealChargeMinor === snapshot.mealChargeMinor),
      detail: bills.some((bill: any) => bill.mealChargeMinor !== snapshot.mealChargeMinor)
        ? "One or more bills use a different per-meal charge from the immutable snapshot."
        : undefined,
    });
  }

  if (payload != null) {
    const payloadPeriodMatches =
      payload?.period?.year === period.year &&
      payload?.period?.month === period.month;
    checks.push({
      key: "payload_period",
      label: "Snapshot payload identifies the same billing period",
      pass: payloadPeriodMatches,
      detail: !payloadPeriodMatches ? "Snapshot payload year/month does not match the period row." : undefined,
    });

    const payloadFormulaVersionId = payload?.formula?.versionId ?? null;
    checks.push({
      key: "formula_version_provenance",
      label: "Frozen formula version matches the period",
      pass: (period.formulaVersionId ?? null) === payloadFormulaVersionId,
      detail:
        (period.formulaVersionId ?? null) !== payloadFormulaVersionId
          ? "Period formula version and snapshot formula provenance differ."
          : undefined,
    });

    const payloadResidents = Array.isArray(payload?.residents) ? payload.residents.length : null;
    checks.push({
      key: "payload_residents",
      label: "Snapshot payload resident list matches frozen resident count",
      pass: payloadResidents === snapshot.residentCount,
      detail:
        payloadResidents !== snapshot.residentCount
          ? `Payload has ${payloadResidents ?? "no"} resident entries; snapshot records ${snapshot.residentCount}.`
          : undefined,
    });

    const totals = payload?.totals ?? {};
    const aggregateMatch =
      totals.residentCount === snapshot.residentCount &&
      totals.residentMealCount === snapshot.residentMealCount &&
      totals.guestMealCount === snapshot.guestMealCount &&
      totals.eligibleExpensesMinor === snapshot.eligibleExpensesMinor &&
      totals.approvedPaymentsMinor === snapshot.approvedPaymentsMinor;
    checks.push({
      key: "payload_aggregates",
      label: "Snapshot payload totals match frozen snapshot columns",
      pass: aggregateMatch,
      detail: !aggregateMatch ? "One or more payload totals differ from the frozen snapshot summary columns." : undefined,
    });
  }

  return {
    periodId,
    snapshotId: snapshot.id,
    checksum: snapshot.checksum,
    valid: checks.every((check) => check.pass),
    checks,
  };
}
