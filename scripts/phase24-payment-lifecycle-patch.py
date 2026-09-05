from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    p.write_text(text.replace(old, new, 1))


def add_import(path: str, anchor: str, line: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if line in text:
        return
    if text.count(anchor) != 1:
        raise SystemExit(f"{label}: import anchor mismatch")
    p.write_text(text.replace(anchor, anchor + line, 1))


# Schema documentation: refund-like payment statuses are compatibility values,
# not current write transitions.
replace_once(
    "prisma/schema.prisma",
    '  status            String    @default("PENDING") // PENDING | APPROVED | REJECTED | VOIDED | REFUNDED | PARTIALLY_REFUNDED\n',
    '  status            String    @default("PENDING") // current: PENDING | APPROVED | REJECTED | VOIDED; legacy read-only: REFUNDED | PARTIALLY_REFUNDED\n',
    "schema payment lifecycle",
)

# Admin payments filter/aggregates.
add_import(
    "src/app/api/v1/admin/payments/route.ts",
    'import { serializePayment } from "@/lib/domain/serialize";\n',
    'import { isPaymentReadStatus, PAYMENT_CREDIT_STATUSES } from "@/lib/domain/payment-lifecycle";\n',
    "admin payments lifecycle import",
)
replace_once(
    "src/app/api/v1/admin/payments/route.ts",
    'const STATUSES = ["PENDING", "APPROVED", "REJECTED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"];\n\n',
    '',
    "admin payment local statuses",
)
replace_once(
    "src/app/api/v1/admin/payments/route.ts",
    '  if (status && !STATUSES.includes(status)) {\n',
    '  if (status && !isPaymentReadStatus(status)) {\n',
    "admin payment filter validation",
)
replace_once(
    "src/app/api/v1/admin/payments/route.ts",
    '        status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },\n',
    '        status: { in: [...PAYMENT_CREDIT_STATUSES] },\n',
    "admin payment credit aggregate",
)

# Resident payment reads/filtering.
add_import(
    "src/app/api/v1/payments/route.ts",
    'import { residentFundsSummary } from "@/lib/domain/funds";\n',
    'import { isPaymentReadStatus, PAYMENT_CREDIT_STATUSES } from "@/lib/domain/payment-lifecycle";\n',
    "resident payments lifecycle import",
)
replace_once(
    "src/app/api/v1/payments/route.ts",
    '  if (status && !["PENDING", "APPROVED", "REJECTED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(status)) {\n',
    '  if (status && !isPaymentReadStatus(status)) {\n',
    "resident payment filter validation",
)
replace_once(
    "src/app/api/v1/payments/route.ts",
    '        status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },\n',
    '        status: { in: [...PAYMENT_CREDIT_STATUSES] },\n',
    "resident payment credit aggregate",
)

# Shared funds read model.
add_import(
    "src/lib/domain/funds.ts",
    'import { resolveActiveDeficitRuleSet } from "@/lib/domain/rules/deficit-rules";\n',
    'import { PAYMENT_CREDIT_STATUSES } from "@/lib/domain/payment-lifecycle";\n',
    "funds lifecycle import",
)
replace_once(
    "src/lib/domain/funds.ts",
    '      where: { residentId, status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] } },\n',
    '      where: { residentId, status: { in: [...PAYMENT_CREDIT_STATUSES] } },\n',
    "funds credit statuses",
)

# Admin funds KPI.
add_import(
    "src/app/api/v1/admin/funds/route.ts",
    'import { residentFundsSummary } from "@/lib/domain/funds";\n',
    'import { PAYMENT_CREDIT_STATUSES } from "@/lib/domain/payment-lifecycle";\n',
    "admin funds lifecycle import",
)
replace_once(
    "src/app/api/v1/admin/funds/route.ts",
    '        status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },\n',
    '        status: { in: [...PAYMENT_CREDIT_STATUSES] },\n',
    "admin funds credit statuses",
)

# Formula provider must use identical payment-credit semantics.
add_import(
    "src/lib/domain/formula/providers/funds.ts",
    'import { getAccountBalances } from "@/lib/domain/ledger";\n',
    'import { PAYMENT_CREDIT_STATUSES } from "@/lib/domain/payment-lifecycle";\n',
    "formula funds lifecycle import",
)
replace_once(
    "src/lib/domain/formula/providers/funds.ts",
    '      where: { institutionId, status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] } },\n',
    '      where: { institutionId, status: { in: [...PAYMENT_CREDIT_STATUSES] } },\n',
    "formula funds credit statuses",
)

# Billing settlement uses the same credit pool.
add_import(
    "src/lib/domain/billing.ts",
    'import { isBillPastDueDate } from "./bill-status";\n',
    'import { PAYMENT_CREDIT_STATUSES } from "./payment-lifecycle";\n',
    "billing lifecycle import",
)
replace_once(
    "src/lib/domain/billing.ts",
    '          status: { in: ["APPROVED", "REFUNDED", "PARTIALLY_REFUNDED"] },\n',
    '          status: { in: [...PAYMENT_CREDIT_STATUSES] },\n',
    "billing credit statuses",
)

# Ledger reconciliation keeps historical compatibility explicit.
add_import(
    "src/lib/domain/ledger.ts",
    'import { ApiError, CODES } from "@/lib/errors";\n',
    'import { PAYMENT_LEDGER_STATUSES } from "@/lib/domain/payment-lifecycle";\n',
    "ledger lifecycle import",
)
replace_once(
    "src/lib/domain/ledger.ts",
    '        status: { in: ["APPROVED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"] },\n',
    '        status: { in: [...PAYMENT_LEDGER_STATUSES] },\n',
    "ledger payment statuses",
)

# Voiding recognizes legacy values, but no current code writes them.
add_import(
    "src/app/api/v1/admin/payments/[id]/void/route.ts",
    'import { resolveNotificationsForEntity } from "@/lib/domain/notify";\n',
    'import { isLegacyPaymentRefundStatus } from "@/lib/domain/payment-lifecycle";\n',
    "void lifecycle import",
)
replace_once(
    "src/app/api/v1/admin/payments/[id]/void/route.ts",
    '    if (payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") {\n',
    '    if (isLegacyPaymentRefundStatus(payment.status)) {\n',
    "void legacy status guard",
)
replace_once(
    "src/app/api/v1/admin/payments/[id]/void/route.ts",
    '        "Refunded payments cannot be voided — issue a correcting refund instead.",\n',
    '        "This legacy refunded payment cannot be voided directly. Use the account refund history for correction.",\n',
    "void legacy error copy",
)

# Client type documents compatibility rather than implying an active refund transition.
replace_once(
    "src/components/app/resident/_shared/types.ts",
    '  status: "PENDING" | "APPROVED" | "REJECTED" | "VOIDED" | "REFUNDED" | "PARTIALLY_REFUNDED" | string;\n',
    '  status: "PENDING" | "APPROVED" | "REJECTED" | "VOIDED" | "REFUNDED" | "PARTIALLY_REFUNDED" | string; // refund-like values are legacy read-only compatibility\n',
    "resident payment status documentation",
)

print("Phase 24 payment lifecycle patch applied")
