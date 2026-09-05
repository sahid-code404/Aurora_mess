from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Funds settlement: persisted bill status must use institution-local calendar
# semantics instead of comparing a UTC-midnight date marker to wall-clock UTC.
# ---------------------------------------------------------------------------
path = "src/lib/domain/funds.ts"
replace_once(
    path,
    'import { resolveActiveDeficitRuleSet } from "@/lib/domain/rules/deficit-rules";\n',
    'import { resolveActiveDeficitRuleSet } from "@/lib/domain/rules/deficit-rules";\nimport { effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''function deriveBillStatus(
  bill: { dueDate: Date },
  totalDueMinor: number,
  appliedMinor: number
): string {
  if (totalDueMinor === 0) return "PAID";
  if (bill.dueDate < new Date()) return "OVERDUE";
  return appliedMinor > 0 ? "PARTIALLY_PAID" : "GENERATED";
}
''',
    '''function deriveBillStatus(
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
''',
)
replace_once(
    path,
    '''export async function recomputeBillSettlement(
  client: any,
  residentId: string
): Promise<{ poolMinor: number; changedBills: BillApplication[]; unappliedMinor: number }> {
  const poolAgg = await client.payment.aggregate({
''',
    '''export async function recomputeBillSettlement(
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
''',
)
replace_once(
    path,
    '    const status = deriveBillStatus(bill, totalDueMinor, appliedMinor);',
    '    const status = deriveBillStatus(bill, totalDueMinor, appliedMinor, timeZone, statusNow);',
)

# ---------------------------------------------------------------------------
# Shared payment-status derivation used by resident dashboard/list APIs.
# ---------------------------------------------------------------------------
path = "src/lib/domain/billing.ts"
replace_once(
    path,
    'import { billingSnapshotChecksum } from "./billing-integrity";\n',
    'import { billingSnapshotChecksum } from "./billing-integrity";\nimport { isBillPastDueDate } from "./bill-status";\n',
)
replace_once(
    path,
    '''export function derivePaymentStatus(bills: { status: string; dueDate: Date }[]): string {
  const unsettled = bills.filter((b) => UNSETTLED_BILL_STATUSES.includes(b.status));
  if (unsettled.some((b) => b.status === "OVERDUE" || b.dueDate < new Date())) return "Overdue";
  if (unsettled.length > 0) return "Due";
  return "Settled";
}
''',
    '''export function derivePaymentStatus(
  bills: { status: string; dueDate: Date }[],
  timeZone = "Asia/Kolkata",
  now = new Date()
): string {
  const unsettled = bills.filter((b) => UNSETTLED_BILL_STATUSES.includes(b.status));
  if (unsettled.some((b) => isBillPastDueDate(b.dueDate, timeZone, now))) return "Overdue";
  if (unsettled.length > 0) return "Due";
  return "Settled";
}
''',
)

# Dashboard already resolves institution timezone and one authoritative clock.
replace_once(
    "src/app/api/v1/me/dashboard/route.ts",
    '  const paymentStatus = derivePaymentStatus(unsettledBills);',
    '  const paymentStatus = derivePaymentStatus(unsettledBills, tz, now);',
)

# ---------------------------------------------------------------------------
# Resident bill list: compute overdue count, sorting and returned status from
# the institution-local date marker.
# ---------------------------------------------------------------------------
path = "src/app/api/v1/bills/route.ts"
replace_once(
    path,
    'import { db } from "@/lib/db";\n',
    'import { db } from "@/lib/db";\nimport { getInstitution } from "@/lib/institution";\n',
)
replace_once(
    path,
    'import { serializeBill } from "@/lib/domain/serialize";\n',
    'import { serializeBill } from "@/lib/domain/serialize";\nimport { currentLocalDateMarker, effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  const { where, take } = keysetWhere(
''',
    '''  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const now = new Date();
  const todayMarker = currentLocalDateMarker(timeZone, now);

  const { where, take } = keysetWhere(
''',
)
replace_once(
    path,
    '''  const overdueCount = unsettled.filter(
    (b) => b.status === "OVERDUE" || b.dueDate < new Date()
  ).length;
  const paymentStatus = derivePaymentStatus(unsettled);

  const now = new Date();
  const sortedItems = [...page.items].sort((a, b) => {
    const isOverdue = (bill: typeof a) =>
      bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate < now);
''',
    '''  const overdueCount = unsettled.filter((b) => b.dueDate < todayMarker).length;
  const paymentStatus = derivePaymentStatus(unsettled, timeZone, now);

  const sortedItems = [...page.items].sort((a, b) => {
    const isOverdue = (bill: typeof a) => bill.totalDueMinor > 0 && bill.dueDate < todayMarker;
''',
)
replace_once(
    path,
    '    data: sortedItems.map((b) => serializeBill(b)),',
    '''    data: sortedItems.map((b) => ({
      ...serializeBill(b),
      status: effectiveBillStatus(b, timeZone, now),
    })),''',
)

# ---------------------------------------------------------------------------
# Admin bill list: effective status filters + KPIs + sort + payload.
# ---------------------------------------------------------------------------
path = "src/app/api/v1/admin/bills/route.ts"
replace_once(
    path,
    'import { db } from "@/lib/db";\n',
    'import { db } from "@/lib/db";\nimport { getInstitution } from "@/lib/institution";\n',
)
replace_once(
    path,
    'import { serializeBill } from "@/lib/domain/serialize";\n',
    'import { serializeBill } from "@/lib/domain/serialize";\nimport { currentLocalDateMarker, effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));

  const fields: Record<string, string> = {};
''',
    '''  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const now = new Date();
  const todayMarker = currentLocalDateMarker(timeZone, now);

  const fields: Record<string, string> = {};
''',
)
replace_once(
    path,
    '''  const base: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (periodId) base.billingPeriodId = periodId;
  if (status) base.status = status;
''',
    '''  const base: Record<string, unknown> = { institutionId: ctx.institutionId };
  if (periodId) base.billingPeriodId = periodId;
  if (status === "VOIDED") {
    base.status = "VOIDED";
  } else if (status === "PAID") {
    base.status = { not: "VOIDED" };
    base.totalDueMinor = 0;
  } else if (status === "OVERDUE") {
    base.status = { not: "VOIDED" };
    base.totalDueMinor = { gt: 0 };
    base.dueDate = { lt: todayMarker };
  } else if (status === "PARTIALLY_PAID") {
    base.status = { not: "VOIDED" };
    base.totalDueMinor = { gt: 0 };
    base.paymentsMinor = { gt: 0 };
    base.dueDate = { gte: todayMarker };
  } else if (status === "GENERATED") {
    base.status = { not: "VOIDED" };
    base.totalDueMinor = { gt: 0 };
    base.paymentsMinor = 0;
    base.dueDate = { gte: todayMarker };
  }
''',
)
replace_once(
    path,
    '''  const overdueWhere: Record<string, unknown> = {
    institutionId: ctx.institutionId,
    status: { in: ["GENERATED", "PARTIALLY_PAID", "OVERDUE"] },
    dueDate: { lt: new Date() },
    ...(periodId ? { billingPeriodId: periodId } : {}),
  };
''',
    '''  const overdueWhere: Record<string, unknown> = {
    institutionId: ctx.institutionId,
    status: { not: "VOIDED" },
    totalDueMinor: { gt: 0 },
    dueDate: { lt: todayMarker },
    ...(periodId ? { billingPeriodId: periodId } : {}),
  };
''',
)
replace_once(
    path,
    '''  const now = new Date();
  const sortedItems = [...page.items].sort((a, b) => {
    const isOverdue = (bill: typeof a) =>
      bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate < now);
''',
    '''  const sortedItems = [...page.items].sort((a, b) => {
    const isOverdue = (bill: typeof a) => bill.totalDueMinor > 0 && bill.dueDate < todayMarker;
''',
)
replace_once(
    path,
    '''    data: sortedItems.map((b) => ({
      ...serializeBill(b),
      residentName: nameMap.get(b.residentId) ?? "Resident",
    })),
''',
    '''    data: sortedItems.map((b) => ({
      ...serializeBill(b),
      status: effectiveBillStatus(b, timeZone, now),
      residentName: nameMap.get(b.residentId) ?? "Resident",
    })),
''',
)

# ---------------------------------------------------------------------------
# Resident billing summary / recent bills.
# ---------------------------------------------------------------------------
path = "src/app/api/v1/billing/route.ts"
replace_once(
    path,
    'import { serializeBill } from "@/lib/domain/serialize";\n',
    'import { serializeBill } from "@/lib/domain/serialize";\nimport { currentLocalDateMarker, effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''  const tz = inst.timezone;

  const period = await getOrCreateOpenPeriod(ctx.institutionId, tz);
''',
    '''  const tz = inst.timezone;
  const now = new Date();
  const todayMarker = currentLocalDateMarker(tz, now);

  const period = await getOrCreateOpenPeriod(ctx.institutionId, tz);
''',
)
replace_once(
    path,
    '''        .sort((a, b) => {
          const now = new Date();
          const isOverdue = (bill: typeof a) =>
            bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate < now);
''',
    '''        .sort((a, b) => {
          const isOverdue = (bill: typeof a) => bill.totalDueMinor > 0 && bill.dueDate < todayMarker;
''',
)
replace_once(
    path,
    '        .map((b) => serializeBill(b)),',
    '''        .map((b) => ({
          ...serializeBill(b),
          status: effectiveBillStatus(b, tz, now),
        })),''',
)

# Resident bill detail uses the same effective status as the list.
path = "src/app/api/v1/bills/[id]/route.ts"
replace_once(
    path,
    'import { db } from "@/lib/db";\n',
    'import { db } from "@/lib/db";\nimport { getInstitution } from "@/lib/institution";\n',
)
replace_once(
    path,
    'import { serializeBill, serializeBillLine } from "@/lib/domain/serialize";\n',
    'import { serializeBill, serializeBillLine } from "@/lib/domain/serialize";\nimport { effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''  const snapshot = await db.billingSnapshot.findUnique({
''',
    '''  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const now = new Date();

  const snapshot = await db.billingSnapshot.findUnique({
''',
)
replace_once(
    path,
    '''      ...serializeBill(bill),
      lines: bill.lines.map((line) => serializeBillLine(line)),
''',
    '''      ...serializeBill(bill),
      status: effectiveBillStatus(bill, timeZone, now),
      lines: bill.lines.map((line) => serializeBillLine(line)),
''',
)

# Resident 360 bill rows should not expose stale UTC-derived status.
path = "src/app/api/v1/admin/residents/[id]/route.ts"
replace_once(
    path,
    'import { zonedTimeToUtc } from "@/lib/time";\n',
    'import { zonedTimeToUtc } from "@/lib/time";\nimport { effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''  const [statusHistory, funds, payments, bills, tasks, leave, audit, refunds] = await Promise.all([
''',
    '''  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const statusNow = new Date();

  const [statusHistory, funds, payments, bills, tasks, leave, audit, refunds] = await Promise.all([
''',
)
replace_once(
    path,
    '''        status: b.status,
        totalDueMinor: b.totalDueMinor,
''',
    '''        status: effectiveBillStatus(b, timeZone, statusNow),
        totalDueMinor: b.totalDueMinor,
''',
)

# Admin billing period detail should surface the same effective status.
path = "src/app/api/v1/admin/billing/periods/[id]/route.ts"
replace_once(
    path,
    'import { formatMinor } from "@/lib/money";\n',
    'import { formatMinor } from "@/lib/money";\nimport { getInstitution } from "@/lib/institution";\n',
)
replace_once(
    path,
    'import { verifyBillingPeriodIntegrity } from "@/lib/domain/billing-integrity";\n',
    'import { verifyBillingPeriodIntegrity } from "@/lib/domain/billing-integrity";\nimport { effectiveBillStatus } from "@/lib/domain/bill-status";\n',
)
replace_once(
    path,
    '''  if (!period || period.institutionId !== ctx.institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  }

  const [snapshot, bills, integrity] = await Promise.all([
''',
    '''  if (!period || period.institutionId !== ctx.institutionId) {
    throw new ApiError(CODES.NOT_FOUND, "Billing period not found.", 404);
  }
  const institution = await getInstitution(ctx.institutionId);
  const timeZone = institution?.timezone ?? "UTC";
  const statusNow = new Date();

  const [snapshot, bills, integrity] = await Promise.all([
''',
)
replace_once(
    path,
    '        status: bill.status,',
    '        status: effectiveBillStatus(bill, timeZone, statusNow),',
)

# The resident client receives effective statuses from the server; do not
# independently compare a UTC date marker to browser wall-clock time.
path = "src/components/app/resident/billing.tsx"
replace_once(
    path,
    '''  const sortedBills = useMemo(() => {
    const now = new Date();
    return [...bills].sort((a, b) => {
      const isOverdue = (bill: BillDto) =>
        bill.status === "OVERDUE" || (bill.totalDueMinor > 0 && bill.dueDate && new Date(bill.dueDate) < now);
''',
    '''  const sortedBills = useMemo(() => {
    return [...bills].sort((a, b) => {
      const isOverdue = (bill: BillDto) => bill.status === "OVERDUE";
''',
)

print("Phase 18 institution-local overdue semantics applied")
