"use client";

/**
 * Guest meal + leave dialogs for the Meals view (spec §153, §154).
 * Both show a preview BEFORE submit ("your meal + guests", "meals that will
 * turn off") and post plain-language success toasts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { SheetDialog, SheetFooterActions, GlassField, GlassInput, GlassTextarea, Stepper, FormNotice, InlinePreviewSkeleton, DataRow } from "./ui";
import { GlassButton } from "@/components/glass/GlassButton";
import Money from "@/components/glass/Money";
import { apiJson, useEnvelopeQuery, useInvalidateResident, RESIDENT_KEYS } from "./api";
import { addDaysToKey, formatMinor, formatTimeInTz, friendlyError } from "./format";
import { useNow } from "./use-now";
import type { GuestMealDto, LeavePreview, MealInstanceDto, MealsMeta, MealOptionDto } from "./types";
import { ApiClientError } from "@/lib/api";
import { broadcastNotification } from "@/lib/broadcast";
import { cn } from "@/lib/utils";

/* ------------------------------- guest meal -------------------------------- */

export function GuestMealDialog({
  open,
  onOpenChange,
  tz,
  todayKey,
  guestPriceMinor,
  initialDate,
  initialInstanceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tz: string;
  todayKey: string;
  /** Institution guest price (fallback when the instance is FORMULA priced). */
  guestPriceMinor: number | null;
  /** Date pre-selected when opened from a day's "Add guests" affordance. */
  initialDate?: string;
  /** Meal instance pre-selected when opened from a row's "+ Guest" button. */
  initialInstanceId?: string;
}) {
  const invalidate = useInvalidateResident();
  const [date, setDate] = useState(todayKey);
  const [mealInstanceId, setMealInstanceId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per dialog session — a double-tap or network retry of
  // the same "Add guest meal" click can never charge twice (spec §71).
  const [idempotencyKey, setIdempotencyKey] = useState("");

  // Fresh data for the chosen date (mount-fresh per dialog open).
  useEffect(() => {
    if (open) {
      setDate(initialDate ?? todayKey);
      setMealInstanceId(initialInstanceId ?? "");
      setQuantity(1);
      setNote("");
      setError(null);
      setIdempotencyKey(
        typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `gm-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
    }
  }, [open, todayKey, initialDate, initialInstanceId]);

  const dayQuery = useEnvelopeQuery<MealInstanceDto[], MealsMeta>(open ? "/api/v1/meals" : null, {
    from: date,
    to: date,
  });

  const serverNow = useNow(dayQuery.data?.meta.serverTime ?? null, 10_000);
  const meals = dayQuery.data?.data ?? [];
  const visibleMeals = initialInstanceId
    ? meals.filter((m) => m.id === initialInstanceId)
    : meals;
  const selected = meals.find((m) => m.id === mealInstanceId) ?? null;

  const unitPriceMinor =
    selected?.pricing.strategy === "FIXED" && selected.pricing.fixedPriceMinor != null
      ? selected.pricing.fixedPriceMinor
      : guestPriceMinor;

  const myMealCount = selected ? (selected.myState.effectiveState === "ON" ? 1 : 0) : 0;
  const instanceLocked = (iso: string) => new Date(iso).getTime() <= serverNow;

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiJson<GuestMealDto>("/api/v1/guest-meals", "POST", {
        mealInstanceId: selected.id,
        quantity,
        note: note.trim() || undefined,
        idempotencyKey: idempotencyKey || undefined,
      });
      invalidate([RESIDENT_KEYS.meals, RESIDENT_KEYS.guestMeals, RESIDENT_KEYS.billing, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("guest_meal_booked");
      toast.success(`Guest meal added — ${selected.name} on ${date}`, {
        description: `${quantity} guest${quantity > 1 ? "s" : ""} · ${formatMinor(unitPriceMinor ? unitPriceMinor * quantity : 0)}`,
      });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "MEAL_CUTOFF_PASSED") {
        setError(`${selected.name} is already locked. Guest meals can no longer be added for it.`);
      } else if (err instanceof ApiClientError && err.fields && Object.keys(err.fields).length > 0) {
        setError(Object.values(err.fields)[0] ?? friendlyError(err));
      } else {
        setError(friendlyError(err, "We couldn't add this guest meal. Please try again."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const submitDisabled = !selected || submitting || unitPriceMinor == null;

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title="Add a guest meal"
      description="Guests are charged at a fixed per-meal price on your next bill. Add them before the meal's cutoff."
      footer={
        <SheetFooterActions onCancel={() => onOpenChange(false)}>
          <GlassButton loading={submitting} disabled={submitDisabled} onClick={() => void submit()}>
            Add guest meal
          </GlassButton>
        </SheetFooterActions>
      }
    >
      <div className="space-y-4">
        <GlassField label="Date">
          <GlassInput
            type="date"
            value={date}
            min={todayKey}
            max={addDaysToKey(todayKey, 30)}
            disabled={Boolean(initialInstanceId)}
            onChange={(e) => {
              setDate(e.target.value || todayKey);
              setMealInstanceId("");
            }}
          />
        </GlassField>

        <GlassField label="Meal">
          {dayQuery.isPending ? (
            <InlinePreviewSkeleton />
          ) : visibleMeals.length === 0 ? (
            <p className="glass-inset rounded-md p-3 text-[13px] text-muted-foreground">
              No meals are scheduled on this date.
            </p>
          ) : (
            <div className="space-y-2">
              {visibleMeals.map((m) => {
                const locked = instanceLocked(m.cutoffAt);
                const unavailable = m.myState.effectiveState === "NOT_AVAILABLE";
                return (
                  <button
                    type="button"
                    key={m.id}
                    disabled={locked || unavailable}
                    onClick={() => setMealInstanceId(m.id)}
                    className={cn(
                      "glass-inset flex w-full items-center justify-between gap-3 rounded-md p-3 text-left transition-colors",
                      m.id === mealInstanceId ? "ring-2 ring-ring" : "hover:bg-foreground/5",
                      (locked || unavailable) && "cursor-not-allowed opacity-55 hover:bg-transparent"
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{m.name}</span>
                      <span className="kpi-num block text-xs text-muted-foreground">
                        {formatTimeInTz(m.serviceWindow.startAt, tz)} – {formatTimeInTz(m.serviceWindow.endAt, tz)}
                        {locked ? " · locked" : ""}
                        {m.myState.effectiveState === "ON_LEAVE" ? " · leave" : unavailable ? " · not available" : ""}
                      </span>
                    </span>
                    <span className="kpi-num shrink-0 text-xs font-medium text-muted-foreground">
                      {instanceLocked(m.cutoffAt) ? "—" : `cutoff ${formatTimeInTz(m.cutoffAt, tz)}`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </GlassField>

        <GlassField label="Guests">
          <Stepper value={quantity} onChange={setQuantity} min={1} max={10} label="guests" />
        </GlassField>

        <GlassField label="Note (optional)" hint="Who is visiting — helps the kitchen plan.">
          <GlassInput
            value={note}
            maxLength={200}
            placeholder="e.g. Family visiting for the festival"
            onChange={(e) => setNote(e.target.value)}
          />
        </GlassField>

        {/* Preview BEFORE submit (spec §153) */}
        {selected && (
          <div className="glass-inset rounded-md p-3.5">
            <p className="text-[13px] font-semibold">
              {selected.name} · {selected.serviceDate}
            </p>
            <div className="mt-1">
              <DataRow label="Your meal" value={myMealCount ? "1" : "0"} />
              <DataRow label="Guests" value={String(quantity)} />
              <DataRow label="Total meals" value={String(myMealCount + quantity)} emphasized />
              <DataRow
                label="Estimated guest charge"
                value={unitPriceMinor != null ? <Money minor={unitPriceMinor * quantity} /> : "—"}
              />
              <DataRow label="Cutoff" value={formatTimeInTz(selected.cutoffAt, tz)} />
            </div>
          </div>
        )}

        {error && <FormNotice tone="danger">{error}</FormNotice>}
      </div>
    </SheetDialog>
  );
}

/* --------------------------------- leave ----------------------------------- */

export function LeaveDialog({
  open,
  onOpenChange,
  todayKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todayKey: string;
}) {
  const invalidate = useInvalidateResident();
  const [startDate, setStartDate] = useState(todayKey);
  const [endDate, setEndDate] = useState(todayKey);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mealScope, setMealScope] = useState<"ALL_MEALS" | "SELECTED_MEALS">("ALL_MEALS");
  const [selectedMealIds, setSelectedMealIds] = useState<string[]>([]);
  const previewTimer = useRef<number | null>(null);

  const mealOptionsQuery = useEnvelopeQuery<MealOptionDto[]>(open ? "/api/v1/meal-options" : null);
  const mealOptions = mealOptionsQuery.data?.data ?? [];

  useEffect(() => {
    if (open) {
      setStartDate(todayKey);
      setEndDate(todayKey);
      setReason("");
      setMealScope("ALL_MEALS");
      setSelectedMealIds([]);
      setError(null);
    }
  }, [open, todayKey]);

  const reasonValid = reason.trim().length >= 3;
  const datesValid = startDate <= endDate;
  const selectionValid = mealScope === "ALL_MEALS" || selectedMealIds.length > 0;

  // Server-side impact preview (POST ?preview — never saves). Debounced.
  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open || !datesValid || !reasonValid || !selectionValid) {
      setPreview(null);
      return;
    }
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await apiJson<{ preview: LeavePreview; dayCount: number }>("/api/v1/leave-requests", "POST", {
          startDate,
          endDate,
          reason: reason.trim(),
          mealScope,
          mealDefinitionIds: mealScope === "SELECTED_MEALS" ? selectedMealIds : [],
          preview: true,
        });
        setPreview(res.preview);
      } catch {
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 500);
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
  }, [open, startDate, endDate, reason, datesValid, reasonValid, selectionValid, mealScope, selectedMealIds]);

  const dayCount = useMemo(() => {
    if (!datesValid) return 0;
    return Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  }, [startDate, endDate, datesValid]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await apiJson("/api/v1/leave-requests", "POST", {
        startDate,
        endDate,
        reason: reason.trim(),
        mealScope,
        mealDefinitionIds: mealScope === "SELECTED_MEALS" ? selectedMealIds : [],
      });
      invalidate([RESIDENT_KEYS.leaveRequests, RESIDENT_KEYS.meals, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("leave_requested");
      toast.success("Leave request submitted — waiting for approval");
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.fields && Object.keys(err.fields).length > 0) {
        setError(Object.values(err.fields)[0] ?? friendlyError(err));
      } else {
        setError(friendlyError(err, "We couldn't submit this leave request. Please try again."));
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
      title="Apply for leave"
      description="While you're away, your meals turn OFF for those days once the admin approves."
      footer={
        <SheetFooterActions onCancel={() => onOpenChange(false)}>
          <GlassButton
            loading={submitting}
            disabled={!datesValid || !reasonValid || !selectionValid || submitting}
            onClick={() => void submit()}
          >
            Submit request
          </GlassButton>
        </SheetFooterActions>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <GlassField label="From">
            <GlassInput
              type="date"
              value={startDate}
              min={todayKey}
              max={addDaysToKey(todayKey, 120)}
              onChange={(e) => {
                const v = e.target.value || todayKey;
                setStartDate(v);
                if (endDate < v) setEndDate(v);
              }}
            />
          </GlassField>
          <GlassField label="Until" error={!datesValid ? "End is before the start date." : undefined}>
            <GlassInput
              type="date"
              value={endDate}
              min={startDate}
              max={addDaysToKey(startDate, 60)}
              onChange={(e) => setEndDate(e.target.value || startDate)}
            />
          </GlassField>
        </div>

        <GlassField label="Meals during leave" hint="Choose whether leave applies to every regular meal or only specific meals.">
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setMealScope("ALL_MEALS"); setSelectedMealIds([]); }}
                className={cn(
                  "glass-inset min-h-11 rounded-md px-3 text-sm font-medium transition-all",
                  mealScope === "ALL_MEALS" ? "ring-2 ring-ring text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                All meals
              </button>
              <button
                type="button"
                onClick={() => setMealScope("SELECTED_MEALS")}
                className={cn(
                  "glass-inset min-h-11 rounded-md px-3 text-sm font-medium transition-all",
                  mealScope === "SELECTED_MEALS" ? "ring-2 ring-ring text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Selected meals
              </button>
            </div>

            {mealScope === "SELECTED_MEALS" && (
              <div className="glass-inset rounded-md p-2">
                {mealOptionsQuery.isPending ? (
                  <InlinePreviewSkeleton />
                ) : mealOptions.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No selectable meals are configured.</p>
                ) : (
                  <div className="grid gap-1 sm:grid-cols-2">
                    {mealOptions.map((meal) => {
                      const checked = selectedMealIds.includes(meal.id);
                      return (
                        <button
                          key={meal.id}
                          type="button"
                          aria-pressed={checked}
                          onClick={() =>
                            setSelectedMealIds((current) =>
                              current.includes(meal.id) ? current.filter((id) => id !== meal.id) : [...current, meal.id]
                            )
                          }
                          className={cn(
                            "flex min-h-10 items-center justify-between rounded-md px-3 text-left text-sm transition-colors",
                            checked ? "bg-primary/12 font-medium text-primary" : "hover:bg-foreground/5"
                          )}
                        >
                          <span className="truncate">{meal.name}</span>
                          <span className={cn("ml-2 text-xs", checked ? "text-primary" : "text-muted-foreground")}>
                            {checked ? "Selected" : "Add"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </GlassField>

        <GlassField
          label="Reason"
          error={reason.trim().length > 0 && !reasonValid ? "A short reason is required." : undefined}
          hint="Tell the admin why you'll be away."
        >
          <GlassTextarea
            value={reason}
            maxLength={500}
            placeholder="e.g. Family function out of town"
            onChange={(e) => setReason(e.target.value)}
          />
        </GlassField>

        {/* Impact preview BEFORE submit (spec §154) */}
        <div className="glass-inset rounded-md p-3.5">
          <p className="text-[13px] font-semibold">
            {dayCount} day{dayCount !== 1 ? "s" : ""} of leave
          </p>
          <div className="mt-1">
            {!datesValid || !reasonValid || !selectionValid ? (
              <p className="py-1.5 text-xs text-muted-foreground">
                {!selectionValid ? "Select at least one meal to preview this leave." : "Write a short reason to see how many meals will be affected."}
              </p>
            ) : previewLoading ? (
              <InlinePreviewSkeleton />
            ) : preview ? (
              <>
                <DataRow label="Meals that will turn off" value={String(preview.futureUnlockedMeals)} />
                <DataRow label="Locked meals (stay unchanged)" value={String(preview.alreadyLockedMeals)} />
              </>
            ) : (
              <p className="py-1.5 text-xs text-muted-foreground">
                We'll count the affected meals when you submit.
              </p>
            )}
          </div>
        </div>

        {error && <FormNotice tone="danger">{error}</FormNotice>}
      </div>
    </SheetDialog>
  );
}
