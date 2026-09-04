"use client";

/**
 * SubmitPaymentDialog — shared by Billing + Payments views (spec §37-38 UX).
 * Multipart POST /api/v1/payments: amount (decimal string) · method chips ·
 * reference · optional proof (JPEG/PNG/PDF ≤2MB) · notes.
 * On success: "Payment submitted — waiting for admin verification".
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Banknote, Landmark, Smartphone, Wallet2, type LucideIcon } from "lucide-react";

import { SheetDialog, SheetFooterActions, GlassField, AmountInput, GlassInput, GlassTextarea, FileProofInput, FormNotice, proofProblems } from "./ui";
import { GlassButton } from "@/components/glass/GlassButton";
import { SegmentedControl } from "@/components/glass/SegmentedControl";
import { apiMultipart, useInvalidateResident, RESIDENT_KEYS } from "./api";
import { friendlyError, monthLabel, parseAmountToMinor, formatMinor } from "./format";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { broadcastNotification } from "@/lib/broadcast";

export interface PayableBill {
  id: string;
  billNumber: string;
  year: number;
  month: number;
  totalDueMinor: number;
  status: string;
}

const METHODS: { value: "UPI" | "CASH" | "BANK_TRANSFER" | "OTHER"; label: string; icon: LucideIcon }[] = [
  { value: "UPI", label: "UPI", icon: Smartphone },
  { value: "CASH", label: "Cash", icon: Banknote },
  { value: "BANK_TRANSFER", label: "Bank transfer", icon: Landmark },
  { value: "OTHER", label: "Other", icon: Wallet2 },
];

function decimalString(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function SubmitPaymentDialog({
  open,
  onOpenChange,
  bills,
  presetBillId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unsettled bills offered as amount presets (may be empty). */
  bills: PayableBill[];
  /** Bill to preselect when opening from a bill card. */
  presetBillId?: string | null;
}) {
  const invalidate = useInvalidateResident();
  const [segment, setSegment] = useState<"bill" | "custom">(bills.length > 0 ? "bill" : "custom");
  const [billId, setBillId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"UPI" | "CASH" | "BANK_TRANSFER" | "OTHER">("UPI");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per dialog session — a double-tap or network retry
  // can never submit the same payment twice (server replays the original).
  const [idempotencyKey, setIdempotencyKey] = useState("");

  // Reset the form each time the dialog opens (mount-fresh via key below).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setProof(null);
    setProofError(null);
    setReference("");
    setNotes("");
    setMethod("UPI");
    setIdempotencyKey(
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const preset = bills.find((b) => b.id === presetBillId);
    if (preset) {
      setSegment("bill");
      setBillId(preset.id);
      setAmount(decimalString(preset.totalDueMinor));
    } else if (bills.length > 0) {
      setSegment("bill");
      setBillId(bills[0].id);
      setAmount(decimalString(bills[0].totalDueMinor));
    } else {
      setSegment("custom");
      setBillId("");
      setAmount("");
    }
     
  }, [open, presetBillId]);

  const selectedBill = useMemo(() => bills.find((b) => b.id === billId) ?? null, [bills, billId]);
  const amountMinor = parseAmountToMinor(amount);
  const amountInvalid = amount.trim() !== "" && amountMinor === null;

  const canSubmit =
    amountMinor !== null && amountMinor > 0 && amountMinor <= 100_000_000 && !proofError && !submitting;

  async function submit() {
    if (amountMinor === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("amount", decimalString(amountMinor));
      form.set("method", method);
      if (idempotencyKey) form.set("idempotencyKey", idempotencyKey);
      if (reference.trim()) form.set("reference", reference.trim());
      if (notes.trim()) form.set("notes", notes.trim());
      if (proof) form.set("proof", proof);
      await apiMultipart("/api/v1/payments", form);
      invalidate([RESIDENT_KEYS.payments, RESIDENT_KEYS.billing, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("payment_submitted");
      toast.success("Payment submitted — waiting for admin verification", {
        description: `${formatMinor(amountMinor)} via ${METHODS.find((m) => m.value === method)?.label}${reference.trim() ? ` · ${reference.trim()}` : ""}`,
      });
      onOpenChange(false);
    } catch (err) {
      const apiErr = err instanceof ApiClientError ? err : null;
      if (apiErr?.fields && Object.keys(apiErr.fields).length > 0) {
        setError(Object.values(apiErr.fields)[0] ?? friendlyError(err));
      } else {
        setError(friendlyError(err, "We couldn't submit this payment. Please try again."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title="Submit a payment"
      description="The admin verifies every payment before it is counted. Proof is optional but speeds things up."
      footer={
        <SheetFooterActions onCancel={() => onOpenChange(false)}>
          <GlassButton loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
            Submit payment
          </GlassButton>
        </SheetFooterActions>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        {bills.length > 0 && (
          <SegmentedControl
            options={[
              { value: "bill", label: "Pay a bill" },
              { value: "custom", label: "Other amount" },
            ]}
            value={segment}
            onChange={(v) => {
              setSegment(v as "bill" | "custom");
              if (v === "custom") {
                setBillId("");
              } else {
                const target = selectedBill ?? bills[0];
                setBillId(target.id);
                setAmount(decimalString(target.totalDueMinor));
              }
            }}
            aria-label="Payment type"
          />
        )}

        {segment === "bill" && bills.length > 0 && (
          <GlassField label="Bill">
            <div className="space-y-2">
              {bills.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  onClick={() => {
                    setBillId(b.id);
                    setAmount(decimalString(b.totalDueMinor));
                  }}
                  className={cn(
                    "glass-inset flex w-full items-center justify-between gap-3 rounded-md p-3 text-left transition-colors",
                    b.id === billId ? "ring-2 ring-ring" : "hover:bg-foreground/5"
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{monthLabel(b.year, b.month)}</span>
                    <span className="kpi-num block text-xs text-muted-foreground">
                      {b.billNumber} · due {formatMinor(b.totalDueMinor)}
                    </span>
                  </span>
                  <span className="kpi-num shrink-0 text-sm font-semibold">{formatMinor(b.totalDueMinor)}</span>
                </button>
              ))}
            </div>
          </GlassField>
        )}

        <GlassField
          label="Amount"
          error={amountInvalid ? "Enter an amount like 1500.00 (max ₹10,00,000)." : undefined}
        >
          <AmountInput
            ariaLabel="Payment amount in rupees"
            value={amount}
            invalid={amountInvalid}
            onChange={(v) => setAmount(v)}
          />
        </GlassField>

        <fieldset>
          <legend className="mb-1.5 block text-xs font-medium text-muted-foreground">Method</legend>
          <div className="grid grid-cols-2 gap-2">
            {METHODS.map((m) => {
              const active = method === m.value;
              return (
                <button
                  type="button"
                  key={m.value}
                  aria-pressed={active}
                  onClick={() => setMethod(m.value)}
                  className={cn(
                    "glass-inset flex h-11 items-center justify-center gap-2 rounded-md px-3 text-[13px] font-medium transition-colors",
                    active ? "text-primary ring-2 ring-ring" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <m.icon className="size-4" aria-hidden />
                  {m.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <GlassField label="Reference (optional)" hint="UPI id, transfer number or receipt number — helps the admin verify faster.">
          <GlassInput
            value={reference}
            maxLength={80}
            placeholder="e.g. UPI/77213"
            onChange={(e) => setReference(e.target.value)}
          />
        </GlassField>

        <GlassField label="Note (optional)">
          <GlassTextarea
            value={notes}
            maxLength={500}
            placeholder="Anything the admin should know about this payment"
            onChange={(e) => setNotes(e.target.value)}
          />
        </GlassField>

        <FileProofInput
          file={proof}
          error={proofError}
          onFile={(f) => {
            setProofError(f ? proofProblems(f) : null);
            setProof(f);
          }}
        />

        {error && <FormNotice tone="danger">{error}</FormNotice>}
      </form>
    </SheetDialog>
  );
}
