from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))

# Deep-link Admin Payments directly into the Refund Center.
replace_once(
    "src/components/app/admin/payments.tsx",
    '  const [status, setStatus] = useState("PENDING");',
    '''  const [status, setStatus] = useState(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#/admin/payments/refunds")
      ? "REFUND_CENTER"
      : "PENDING"
  );''',
)

# Funds remains a financial read model. Refund decisions live in Admin Payments
# because a positive advance is not refundable until a bill has been generated.
p = "src/components/app/admin/funds.tsx"
replace_once(
    p,
    'import { Banknote, Calendar, ChevronRight, DoorOpen, Landmark, RotateCcw, ShieldOff, TrendingDown, Wallet } from "lucide-react";',
    'import { Banknote, Calendar, ChevronRight, DoorOpen, Landmark, ShieldOff, TrendingDown, Wallet } from "lucide-react";',
)
replace_once(p, 'import { RefundDialog } from "./_shared/refund-dialog";\n', '')
replace_once(
    p,
    '  const [refundTarget, setRefundTarget] = useState<FundsData["residents"][0] | null>(null);\n',
    '',
)
replace_once(
    p,
    '''                      {r.availableMinor > 0 && (
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRefundTarget(r);
                          }}
                          aria-label={`Issue refund for ${r.fullName}`}
                          className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-primary transition-all hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          <span>Refund</span>
                        </motion.button>
                      )}

''',
    '',
)
replace_once(
    p,
    '''      {refundTarget && (
        <RefundDialog
          open={Boolean(refundTarget)}
          onOpenChange={(open) => !open && setRefundTarget(null)}
          residentId={refundTarget.residentId}
          residentName={refundTarget.fullName}
          availableMinor={refundTarget.availableMinor}
          onSaved={() => invalidate([FUNDS_PATH, "/api/v1/admin/payments", "/api/v1/admin/dashboard"])}
        />
      )}
''',
    '',
)

# Resident 360 keeps refund history but sends new decisions to the canonical
# post-billing Refund Center rather than judging eligibility from available balance.
p = "src/components/app/admin/resident360.tsx"
replace_once(
    p,
    'import { goBack } from "@/hooks/use-hash-route";',
    'import { goBack, navigateTo } from "@/hooks/use-hash-route";',
)
replace_once(p, 'import { RefundDialog } from "./_shared/refund-dialog";\n', '')
replace_once(p, '  const [refundOpen, setRefundOpen] = useState(false);\n', '')
replace_once(
    p,
    '''                  {funds.availableMinor > 0 && (
                    <GlassButton
                      variant="primary"
                      size="sm"
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => setRefundOpen(true)}
                      icon={<RotateCcw className="size-3" />}
                    >
                      Issue refund
                    </GlassButton>
                  )}
''',
    '''                  {bills.length > 0 && funds.availableMinor > 0 && (
                    <GlassButton
                      variant="primary"
                      size="sm"
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => navigateTo("/admin/payments/refunds")}
                      icon={<RotateCcw className="size-3" />}
                    >
                      Refund Center
                    </GlassButton>
                  )}
''',
)
replace_once(
    p,
    '''                {funds.availableMinor > 0 && (
                  <button
                    type="button"
                    onClick={() => setRefundOpen(true)}
                    className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    <RotateCcw className="size-3" />
                    <span>New refund</span>
                  </button>
                )}
''',
    '''                {bills.length > 0 && funds.availableMinor > 0 && (
                  <button
                    type="button"
                    onClick={() => navigateTo("/admin/payments/refunds")}
                    className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    <RotateCcw className="size-3" />
                    <span>Refund Center</span>
                  </button>
                )}
''',
)
replace_once(
    p,
    '''      <RefundDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        residentId={id}
        residentName={profile.fullName}
        availableMinor={funds?.availableMinor ?? 0}
        onSaved={() =>
          invalidate([
            `/api/v1/admin/residents/${id}`,
            "/api/v1/admin/funds",
            "/api/v1/admin/payments",
            "/api/v1/admin/dashboard",
          ])
        }
      />
''',
    '',
)

print("Phase 18 refund initiation centralized")
