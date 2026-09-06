export type FormulaVersionWindow = {
  effectiveFrom?: Date | string | null;
  effectiveUntil?: Date | string | null;
};

/**
 * Select the newest immutable formula version whose effective window covers the
 * requested billing-period boundary. Version arrays may be in any order.
 */
export function selectFormulaVersionAt<T extends FormulaVersionWindow & { version?: number }>(
  versions: readonly T[],
  at: Date
): T | null {
  const farPast = new Date(-864e13);
  const farFuture = new Date(864e13);

  const matches = versions.filter((version) => {
    const from = version.effectiveFrom ? new Date(version.effectiveFrom) : farPast;
    const until = version.effectiveUntil ? new Date(version.effectiveUntil) : farFuture;
    return from <= at && until >= at;
  });

  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
}
