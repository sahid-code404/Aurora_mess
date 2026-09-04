"use client";

import { useState, useEffect, useId } from "react";
import { ArrowDownLeft, Banknote, RotateCcw, ShieldCheck, Wallet } from "lucide-react";
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
  onSaved: () => void;
}

export function RefundDialog({
  open,
  onOpenChange,
  residentId,
  residentName,
  availableMinor,
  onSaved,
}: RefundDialogProps) {
  const [mode, setMode] = useState<"ISSUE_REFUND" | "CARRY_FORWARD">("ISSUE_REFUND");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const amountId = useId();

  // Reset form state when opened
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
  const canSubmit = isAmountValid && isReasonValid && !saving;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await postJson("/api/v1/admin/refunds", {
        residentId,
        amount: (parsedMinor / 100).toFixed(2),
        mode,
        reason: reason.trim(),
        destination: destination.trim() || undefined,
      });

      toast.success(
        mode === "ISSUE_REFUND" ? "Refund issued successfully" : "Excess credit resolved",
        {
          description: `₹${(parsedMinor / 100).toFixed(2)} for ${residentName} — ${reason.trim()}`,
        }
      );

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
      title="Issue refund / Resolve excess credit"
      description={`Process an approved credit refund for ${residentName}. Refunds strictly draw from approved available funds.`}
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
        {/* Resident & Available Funds Snapshot */}
        <div className="glass-inset flex items-center justify-between rounded-xl p-3 sm:p-3.5">
          <div className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block">
              Available Credit
            </span>
            <div className="mt-0.5 flex items-baseline gap-2">
              <Money minor={availableMinor} className="text-lg font-bold text-success" />
              <span className="text-xs text-muted-foreground">approved funds</span>
            </div>
          </div>
          <Chip tone={availableMinor > 0 ? "success" : "neutral"}>
            {availableMinor > 0 ? "Refundable" : "No credit"}
          </Chip>
        </div>

        {/* Mode Selector */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Resolution Mode</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode("ISSUE_REFUND")}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl p-3 text-left transition-all",
                mode === "ISSUE_REFUND"
                  ? "bg-primary/15 border border-primary/40 text-foreground ring-1 ring-primary/30"
                  : "glass-subtle border border-border/40 text-muted-foreground hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-1.5 font-semibold text-xs text-foreground">
                <ArrowDownLeft className="size-3.5 text-primary" />
                <span>Issue Payout</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Cash leaves mess accounts immediately (Dr Resident Funds / Cr Cash).
              </p>
            </button>

            <button
              type="button"
              onClick={() => setMode("CARRY_FORWARD")}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl p-3 text-left transition-all",
                mode === "CARRY_FORWARD"
                  ? "bg-primary/15 border border-primary/40 text-foreground ring-1 ring-primary/30"
                  : "glass-subtle border border-border/40 text-muted-foreground hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-1.5 font-semibold text-xs text-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                <span>Carry Forward</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Keep excess credit on account for upcoming meals and bills.
              </p>
            </button>
          </div>
        </div>

        {/* Amount Input */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor={amountId} className="text-xs font-semibold text-foreground">
              Refund Amount (₹)
            </label>
            {availableMinor > 0 && (
              <button
                type="button"
                onClick={() => setAmount((availableMinor / 100).toFixed(2))}
                className="text-[11px] font-semibold text-primary hover:underline"
              >
                Max available (₹{(availableMinor / 100).toFixed(2)})
              </button>
            )}
          </div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
              ₹
            </span>
            <input
              id={amountId}
              type="number"
              step="0.01"
              min="0.01"
              max={(availableMinor / 100).toFixed(2)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={cn(
                "glass-input w-full rounded-xl py-2 pl-7 pr-3 text-sm font-semibold text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary",
                parsedMinor > availableMinor ? "border-danger ring-1 ring-danger/40" : ""
              )}
            />
          </div>
          {parsedMinor > availableMinor && (
            <p className="text-[11px] font-medium text-danger">
              Amount cannot exceed available credit of ₹{(availableMinor / 100).toFixed(2)}.
            </p>
          )}
        </div>

        {/* Destination (for payouts) */}
        {mode === "ISSUE_REFUND" && (
          <TextField
            label="Payout Destination / Mode"
            value={destination}
            onChange={setDestination}
            maxLength={120}
            placeholder="e.g. UPI ID (resident@upi), Bank account, or Cash"
            hint="Record the channel or payment reference used to transfer the money."
          />
        )}

        {/* Reason (mandatory audit) */}
        <TextField
          label="Reason for refund"
          value={reason}
          onChange={setReason}
          maxLength={500}
          placeholder="e.g. Overpaid mess advance / security deposit return"
          hint="Mandatory audit trail reason (at least 5 characters)."
        />
      </div>
    </DetailDialog>
  );
}
