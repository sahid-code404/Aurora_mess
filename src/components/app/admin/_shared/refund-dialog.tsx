"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDownLeft, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { DetailDialog, Chip } from "./chrome";
import { TextField } from "./fields";
import { GlassButton } from "@/components/glass/GlassButton";
import Money from "@/components/glass/Money";
import { postJson } from "@/hooks/use-api-query";
import { errMessage } from "./api";
import { cn } from "@/lib/utils";

export interface RefundDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  residentId: string;
  residentName: string;
  availableMinor: number;
  latestBillNumber?: string | null;
  billingPeriodLabel?: string | null;
  onSaved: () => void;
}

export function RefundDialog({
  open,
  onOpenChange,
  residentId,
  residentName,
  availableMinor,
  latestBillNumber,
  billingPeriodLabel,
  onSaved,
}: RefundDialogProps) {
  const [mode, setMode] = useState<"ISSUE_REFUND" | "CARRY_FORWARD">("ISSUE_REFUND");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const amountId = useId();

  useEffect(() => {
    if (open) {
      setMode("ISSUE_REFUND");
      setAmount(availableMinor > 0 ? (availableMinor / 100).toFixed(2) : "");
      setDestination("");
      setReason("");
      setSaving(false);
    }
  }, [open, availableMinor]);

  const numericAmount = parseFloat(amount);
  const parsedMinor = Number.isFinite(numericAmount) ? Math.round(numericAmount * 100) : 0;
  const isAmountValid = parsedMinor > 0 && parsedMinor <= availableMinor;
  const isReasonValid = reason.trim().length >= 5;
  const carryForwardUsesFullExcess = mode !== "CARRY_FORWARD" || parsedMinor === availableMinor;
  const canSubmit = isAmountValid && isReasonValid && carryForwardUsesFullExcess && !saving;

  function selectMode(next: "ISSUE_REFUND" | "CARRY_FORWARD") {
    setMode(next);
    if (next === "CARRY_FORWARD" && availableMinor > 0) {
      setAmount((availableMinor / 100).toFixed(2));
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await postJson("/api/v1/admin/refunds", {
        residentId,
        amount: (parsedMinor / 100).toFixed(2),
        mode,
        reason: reason.trim(),
        destination: mode === "ISSUE_REFUND" ? destination.trim() || undefined : undefined,
      });

      toast.success(mode === "ISSUE_REFUND" ? "Refund issued successfully" : "Excess credit carried forward", {
        description: `₹${(parsedMinor / 100).toFixed(2)} for ${residentName} — ${reason.trim()}`,
      });

      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve post-billing excess credit"
      description={`Choose what to do with ${residentName}'s confirmed excess only after billing has been generated.`}
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            loading={saving}
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            icon={<RotateCcw className="size-4" />}
          >
            {mode === "ISSUE_REFUND" ? "Issue payout" : "Carry forward"}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-inset flex items-center justify-between gap-3 rounded-xl p-3 sm:p-3.5"
        >
          <div className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Post-billing excess
            </span>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
              <Money minor={availableMinor} className="text-lg font-bold text-success" />
              <span className="text-xs text-muted-foreground">eligible now</span>
            </div>
            {(latestBillNumber || billingPeriodLabel) && (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {latestBillNumber ?? "Generated bill"}
                {billingPeriodLabel ? ` · ${billingPeriodLabel}` : ""}
              </p>
            )}
          </div>
          <Chip tone={availableMinor > 0 ? "success" : "neutral"}>
            {availableMinor > 0 ? "Refundable" : "No excess"}
          </Chip>
        </motion.div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Resolution mode</label>
          <div className="grid grid-cols-2 gap-2">
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => selectMode("ISSUE_REFUND")}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl p-3 text-left transition-all",
                mode === "ISSUE_REFUND"
                  ? "border border-primary/40 bg-primary/15 text-foreground ring-1 ring-primary/30"
                  : "glass-subtle border border-border/40 text-muted-foreground hover:-translate-y-0.5 hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <ArrowDownLeft className="size-3.5 text-primary" />
                <span>Issue payout</span>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Return some or all excess money now. Cash and resident liability both reduce.
              </p>
            </motion.button>

            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => selectMode("CARRY_FORWARD")}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl p-3 text-left transition-all",
                mode === "CARRY_FORWARD"
                  ? "border border-primary/40 bg-primary/15 text-foreground ring-1 ring-primary/30"
                  : "glass-subtle border border-border/40 text-muted-foreground hover:-translate-y-0.5 hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                <span>Carry forward</span>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Keep the full excess as resident credit until a future bill consumes it.
              </p>
            </motion.button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={amountId} className="text-xs font-semibold text-foreground">
              {mode === "ISSUE_REFUND" ? "Refund amount (₹)" : "Carry-forward amount (₹)"}
            </label>
            {availableMinor > 0 && mode === "ISSUE_REFUND" && (
              <button
                type="button"
                onClick={() => setAmount((availableMinor / 100).toFixed(2))}
                className="text-[11px] font-semibold text-primary hover:underline"
              >
                Use full excess (₹{(availableMinor / 100).toFixed(2)})
              </button>
            )}
          </div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">₹</span>
            <input
              id={amountId}
              type="number"
              step="0.01"
              min="0.01"
              max={(availableMinor / 100).toFixed(2)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={mode === "CARRY_FORWARD"}
              placeholder="0.00"
              className={cn(
                "glass-input w-full rounded-xl py-2 pl-7 pr-3 text-sm font-semibold text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-70",
                parsedMinor > availableMinor ? "border-danger ring-1 ring-danger/40" : ""
              )}
            />
          </div>
          {parsedMinor > availableMinor && (
            <p className="text-[11px] font-medium text-danger">
              Amount cannot exceed post-billing excess of ₹{(availableMinor / 100).toFixed(2)}.
            </p>
          )}
          {mode === "CARRY_FORWARD" && (
            <p className="text-[11px] text-muted-foreground">
              Carry forward resolves this bill cycle completely, so the full excess is retained as future credit.
            </p>
          )}
        </div>

        <AnimatePresence initial={false}>
          {mode === "ISSUE_REFUND" && (
            <motion.div
              key="destination"
              initial={{ opacity: 0, height: 0, y: -6 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={{ opacity: 0, height: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              <TextField
                label="Payout destination / mode"
                value={destination}
                onChange={setDestination}
                maxLength={120}
                placeholder="e.g. UPI ID, bank account, cash, or transfer reference"
                hint="Record how the money was returned for the audit trail."
              />
            </motion.div>
          )}
        </AnimatePresence>

        <TextField
          label="Reason"
          value={reason}
          onChange={setReason}
          maxLength={500}
          placeholder="e.g. Post-billing overpayment for September"
          hint="Mandatory audit trail reason (at least 5 characters)."
        />
      </div>
    </DetailDialog>
  );
}
