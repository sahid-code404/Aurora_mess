/**
 * SERIALIZERS — consistent DTO shapes for the finance domain responses.
 * Every financial payload carries its components (provenance — spec §275):
 * totals are always accompanied by the quantities/prices/counts they derive from.
 */
import { formatMinor } from "@/lib/money";

export function serializePayment(p: any): Record<string, unknown> {
  return {
    id: p.id,
    displayNumber: p.displayNumber,
    amountMinor: p.amountMinor,
    amountFormatted: formatMinor(p.amountMinor),
    method: p.method,
    status: p.status,
    reference: p.reference ?? null,
    notes: p.notes ?? null,
    hasProof: Boolean(p.proofFileId),
    proofFileId: p.proofFileId ?? null,
    submittedAt: p.submittedAt.toISOString(),
    reviewedAt: p.reviewedAt ? p.reviewedAt.toISOString() : null,
    rejectionReason: p.rejectionReason ?? null,
    idempotentKey: p.idempotencyKey ?? null,
  };
}

export function serializeRefund(r: any): Record<string, unknown> {
  return {
    id: r.id,
    amountMinor: r.amountMinor,
    amountFormatted: formatMinor(r.amountMinor),
    mode: r.mode,
    status: r.status,
    reason: r.reason,
    destination: r.destination ?? null,
    paymentId: r.paymentId ?? null,
    journalId: r.journalId ?? null,
    reversalJournalId: r.reversalJournalId ?? null,
    voidReason: r.voidReason ?? null,
    voidedByUserId: r.voidedByUserId ?? null,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
    residentId: r.residentId,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

export function serializeExpense(e: any): Record<string, unknown> {
  return {
    id: e.id,
    displayNumber: e.displayNumber,
    dateKey: e.date ? dateKeyOf(e.date) : null,
    date: e.date ? e.date.toISOString() : null,
    status: e.status,
    source: e.source,
    description: e.description,
    comment: e.comment ?? null,
    totalMinor: e.totalMinor,
    totalFormatted: formatMinor(e.totalMinor),
    categoryId: e.categoryId ?? null,
    categoryName: e.category?.name ?? null,
    hasProof: Boolean(e.proofFileId),
    proofFileId: e.proofFileId ?? null,
    itemCount: e.items ? e.items.length : e._count?.items ?? null,
    submittedByUserId: e.submittedByUserId ?? null,
    approvedByUserId: e.approvedByUserId ?? null,
    reviewedAt: e.reviewedAt ? e.reviewedAt.toISOString() : null,
    journalId: e.journalId ?? null,
    reversalJournalId: e.reversalJournalId ?? null,
    voidReason: e.voidReason ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

function dateKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

export function serializeBillLine(line: any): Record<string, unknown> {
  let detail: Record<string, unknown> | null = null;
  if (line.detailJson) {
    try {
      detail = JSON.parse(line.detailJson);
    } catch {
      detail = null;
    }
  }
  return {
    id: line.id,
    code: line.code,
    label: line.label,
    quantity: line.quantity ?? null,
    unitPriceMinor: line.unitPriceMinor ?? null,
    amountMinor: line.amountMinor,
    amountFormatted: formatMinor(line.amountMinor),
    detail: detail,
    sortOrder: line.sortOrder,
  };
}

export function serializeBill(b: any): Record<string, unknown> {
  return {
    id: b.id,
    billNumber: b.billNumber,
    residentId: b.residentId,
    period: b.period
      ? { id: b.period.id, year: b.period.year, month: b.period.month, status: b.period.status }
      : null,
    status: b.status,
    residentMealCount: b.residentMealCount,
    guestMealCount: b.guestMealCount,
    mealChargeMinor: b.mealChargeMinor,
    guestChargeMinor: b.guestChargeMinor,
    subtotalMinor: b.subtotalMinor,
    subtotalFormatted: formatMinor(b.subtotalMinor),
    adjustmentsMinor: b.adjustmentsMinor,
    paymentsMinor: b.paymentsMinor,
    totalDueMinor: b.totalDueMinor,
    totalDueFormatted: formatMinor(b.totalDueMinor),
    dueDate: b.dueDate.toISOString(),
    generatedAt: b.generatedAt.toISOString(),
    lines: b.lines ? b.lines.map(serializeBillLine) : undefined,
    adjustmentCount: b.adjustments ? b.adjustments.length : undefined,
    snapshotId: b.snapshotId,
  };
}

export function serializeJournal(j: any): Record<string, unknown> {
  const entries = (j.entries ?? []).map((e: any) => ({
    id: e.id,
    accountCode: e.account?.code ?? null,
    accountName: e.account?.name ?? null,
    debitMinor: e.debitMinor,
    creditMinor: e.creditMinor,
    debitFormatted: e.debitMinor > 0 ? formatMinor(e.debitMinor) : null,
    creditFormatted: e.creditMinor > 0 ? formatMinor(e.creditMinor) : null,
  }));
  const totalDebit = (j.entries ?? []).reduce((s: number, e: any) => s + e.debitMinor, 0);
  const totalCredit = (j.entries ?? []).reduce((s: number, e: any) => s + e.creditMinor, 0);
  return {
    id: j.id,
    refType: j.refType ?? null,
    refId: j.refId ?? null,
    description: j.description,
    status: j.status,
    createdAt: j.createdAt.toISOString(),
    entries,
    totalDebitMinor: totalDebit,
    totalCreditMinor: totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

export function serializeNotification(n: any): Record<string, unknown> {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    entityRef: n.entityRef ?? null,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}
