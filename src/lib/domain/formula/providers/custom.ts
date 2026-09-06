/**
 * CUSTOM VARIABLE PROVIDER (spec §17-21, §72-73, §92-93)
 * Resolves Admin-created custom variables for the specified billing period context
 * respecting effective-date windows and versioning.
 */
import { PeriodBounds } from "../period-variables";

export async function resolveCustomVariables(
  institutionId: string,
  bounds: PeriodBounds,
  residentId: string | undefined,
  client: any
): Promise<Record<string, number>> {
  // Find all active (non-archived) custom variable definitions
  const customDefs = await client.variableDefinition.findMany({
    where: {
      institutionId,
      category: "CUSTOM",
      OR: [{ archivedAt: null }, { archivedAt: { gt: bounds.startAt } }],
    },
    include: {
      customValues: {
        orderBy: { effectiveFrom: "desc" },
      },
    },
  });

  const periodStart = bounds.startAt;
  const periodKey = bounds.periodKey;
  const result: Record<string, number> = {};

  for (const def of customDefs) {
    // 1. Look for explicit billingPeriodKey match first
    let valRow = def.customValues.find((v: any) => v.billingPeriodKey === periodKey);

    // 2. Fall back to effective date range
    if (!valRow) {
      valRow = def.customValues.find((v: any) => {
        const from = v.effectiveFrom ? new Date(v.effectiveFrom) : null;
        const until = v.effectiveUntil ? new Date(v.effectiveUntil) : null;
        if (from && from > periodStart) return false;
        if (until && until < periodStart) return false;
        return true;
      });
    }

    if (valRow) {
      if (def.valueType === "MONEY") {
        result[def.key] = valRow.valueMinor ?? (valRow.valueNumber ? Math.round(valRow.valueNumber * 100) : 0);
      } else if (def.valueType === "BOOLEAN") {
        result[def.key] = valRow.valueBoolean ? 1 : 0;
      } else if (def.valueType === "PERCENTAGE") {
        // e.g. 2% stored as 2, normalized in AST as valueNumber
        result[def.key] = valRow.valueNumber ?? 0;
      } else {
        result[def.key] = valRow.valueNumber ?? (valRow.valueMinor ?? 0);
      }
    }
  }

  return result;
}
