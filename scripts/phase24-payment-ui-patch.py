from pathlib import Path

p = Path('src/components/app/resident/payments.tsx')
s = p.read_text()

replacements = [
    (
        'import { useEnvelopeQuery } from "./_shared/api";',
        'import { apiJson, RESIDENT_KEYS, useEnvelopeQuery, useInvalidateResident } from "./_shared/api";'
    ),
    (
        'function PaymentDetailDialog({\n  payment,\n  onClose,\n  tz,\n}: {\n  payment: PaymentDto | null;\n  onClose: () => void;\n  tz: string;\n}) {',
        'function PaymentDetailDialog({\n  payment,\n  onClose,\n  onWithdraw,\n  tz,\n}: {\n  payment: PaymentDto | null;\n  onClose: () => void;\n  onWithdraw: (payment: PaymentDto) => void;\n  tz: string;\n}) {'
    ),
    (
        '              <p className="mt-0.5 text-muted-foreground">\n                Your payment was submitted and is awaiting admin verification. Once approved, the funds will be added to your mess balance.\n              </p>',
        '              <p className="mt-0.5 text-muted-foreground">\n                Your payment was submitted and is awaiting admin verification. Once approved, the funds will be added to your mess balance. If this submission was a mistake, you can withdraw it before an admin reviews it.\n              </p>'
    ),
    (
        '          {payment.status === "APPROVED" && (\n            <div className="rounded-xl border border-success/30 bg-success/10 p-3 text-xs text-success leading-relaxed">\n              <p className="font-semibold">Verified & Approved</p>\n              <p className="mt-0.5 text-muted-foreground">\n                This payment was verified and credited to your mess account.\n              </p>\n            </div>\n          )}',
        '          {payment.status === "APPROVED" && (\n            <div className="rounded-xl border border-success/30 bg-success/10 p-3 text-xs text-success leading-relaxed">\n              <p className="font-semibold">Verified & Approved</p>\n              <p className="mt-0.5 text-muted-foreground">\n                This payment was verified and credited to your mess account.\n              </p>\n            </div>\n          )}\n\n          {payment.status === "VOIDED" && (\n            <div className="rounded-xl border border-border/50 bg-muted/45 p-3 text-xs leading-relaxed">\n              <p className="font-semibold text-foreground">Payment closed</p>\n              <p className="mt-0.5 text-muted-foreground">\n                This payment is no longer part of your approved balance. Pending submissions can be withdrawn before review; approved payments can only be voided by an administrator with an auditable reversal.\n              </p>\n            </div>\n          )}'
    ),
    (
        '        <div className="mt-4 flex justify-end">\n          <GlassButton onClick={onClose} variant="secondary" className="w-full sm:w-auto px-6">\n            Close\n          </GlassButton>\n        </div>',
        '        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">\n          {payment.status === "PENDING" && (\n            <GlassButton\n              onClick={() => onWithdraw(payment)}\n              variant="destructive"\n              className="w-full sm:w-auto px-6"\n            >\n              Withdraw submission\n            </GlassButton>\n          )}\n          <GlassButton onClick={onClose} variant="secondary" className="w-full sm:w-auto px-6">\n            Close\n          </GlassButton>\n        </div>'
    ),
    (
        '  const tz = institution?.timezone ?? "Asia/Kolkata";\n\n  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);',
        '  const tz = institution?.timezone ?? "Asia/Kolkata";\n  const invalidate = useInvalidateResident();\n\n  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);'
    ),
    (
        '  const [payOpen, setPayOpen] = useState(false);\n  const [selectedPayment, setSelectedPayment] = useState<PaymentDto | null>(null);',
        '  const [payOpen, setPayOpen] = useState(false);\n  const [selectedPayment, setSelectedPayment] = useState<PaymentDto | null>(null);\n  const [withdrawTarget, setWithdrawTarget] = useState<PaymentDto | null>(null);\n  const [withdrawBusy, setWithdrawBusy] = useState(false);\n  const [withdrawError, setWithdrawError] = useState<string | null>(null);'
    ),
    (
        '  const availableMinor =\n    meta?.totalAvailableMinor ?? billingQuery.data?.creditsBreakdown?.availableMinor ?? 0;\n\n  return (',
        '  const availableMinor =\n    meta?.totalAvailableMinor ?? billingQuery.data?.creditsBreakdown?.availableMinor ?? 0;\n\n  async function withdrawPendingPayment() {\n    if (!withdrawTarget || withdrawBusy) return;\n    setWithdrawBusy(true);\n    setWithdrawError(null);\n    try {\n      await apiJson<PaymentDto>(`/api/v1/payments/${withdrawTarget.id}/cancel`, "POST", {});\n      setWithdrawTarget(null);\n      setSelectedPayment(null);\n      invalidate([\n        RESIDENT_KEYS.payments,\n        RESIDENT_KEYS.billing,\n        RESIDENT_KEYS.dashboard,\n        RESIDENT_KEYS.notifications,\n      ]);\n    } catch (error) {\n      setWithdrawError(error instanceof Error ? error.message : "Could not withdraw this payment. Refresh and try again.");\n    } finally {\n      setWithdrawBusy(false);\n    }\n  }\n\n  return ('
    ),
    (
        '      <PaymentDetailDialog\n        payment={selectedPayment}\n        onClose={() => setSelectedPayment(null)}\n        tz={tz}\n      />',
        '      <PaymentDetailDialog\n        payment={selectedPayment}\n        onClose={() => setSelectedPayment(null)}\n        onWithdraw={(payment) => {\n          setWithdrawError(null);\n          setWithdrawTarget(payment);\n        }}\n        tz={tz}\n      />\n\n      <Dialog\n        open={Boolean(withdrawTarget)}\n        onOpenChange={(open) => {\n          if (!open && !withdrawBusy) {\n            setWithdrawTarget(null);\n            setWithdrawError(null);\n          }\n        }}\n      >\n        <DialogContent className="glass-panel border-border/60 max-w-md rounded-3xl p-5 sm:p-6 shadow-2xl">\n          <DialogTitle className="text-base sm:text-lg font-bold">Withdraw payment submission?</DialogTitle>\n          <DialogDescription className="text-sm leading-relaxed text-muted-foreground">\n            {withdrawTarget\n              ? `${withdrawTarget.displayNumber} (${formatMinor(withdrawTarget.amountMinor)}) is still waiting for Admin review. Withdrawing it removes it from the pending queue without touching your approved balance or any bill settlement.`\n              : "This pending payment can be withdrawn before Admin review."}\n          </DialogDescription>\n\n          <AnimatePresence initial={false}>\n            {withdrawError && (\n              <motion.div\n                initial={{ opacity: 0, y: -4 }}\n                animate={{ opacity: 1, y: 0 }}\n                exit={{ opacity: 0, y: -4 }}\n                className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger"\n                role="alert"\n              >\n                {withdrawError}\n              </motion.div>\n            )}\n          </AnimatePresence>\n\n          <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">\n            <GlassButton\n              variant="secondary"\n              disabled={withdrawBusy}\n              onClick={() => {\n                setWithdrawTarget(null);\n                setWithdrawError(null);\n              }}\n              className="w-full sm:w-auto"\n            >\n              Keep pending\n            </GlassButton>\n            <GlassButton\n              variant="destructive"\n              disabled={withdrawBusy}\n              onClick={() => void withdrawPendingPayment()}\n              className="w-full sm:w-auto"\n            >\n              {withdrawBusy ? "Withdrawing…" : "Withdraw submission"}\n            </GlassButton>\n          </div>\n        </DialogContent>\n      </Dialog>'
    ),
]

for old, new in replacements:
    if new in s:
        continue
    if old not in s:
        raise SystemExit(f'missing expected marker:\n{old[:240]}')
    s = s.replace(old, new, 1)

p.write_text(s)
print('Phase 24 resident payment UI patch applied')
