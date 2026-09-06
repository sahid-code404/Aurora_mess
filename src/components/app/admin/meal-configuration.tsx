"use client";

/**
 * Admin Meal Configuration — meal definitions with versioned edits.
 * GET /api/v1/admin/meal-definitions · GET/PUT /:id · POST (create) ·
 * POST /:id/archive · POST /:id/request-deletion
 * Create/Edit = one 6-step wizard dialog; PUT creates a new version.
 */

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  History,
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
  Utensils,
} from "lucide-react";
import { toast } from "sonner";
import { KpiCard } from "@/components/glass/KpiCard";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { KpiGridSkeleton, ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import SegmentedControl from "@/components/glass/SegmentedControl";
import GlassToggle from "@/components/glass/GlassToggle";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { api } from "@/lib/api";
import { ApiClientError } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SPRING_SNAPPY } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useApiMetaQuery, errMessage, useInvalidate, metaNum } from "./_shared/api";
import {
  ColorTokenPicker,
  IconPicker,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
  WeekdayPicker,
  moneyProblem,
  mealIcon,
} from "./_shared/fields";
import { Chip, KeyValue, OverflowMenu, ViewButton } from "./_shared/chrome";
import { cutoffPlainWords, fmtDate, fmtDateTime, formatHhMm, mealHex, scheduleLabel } from "./_shared/format";
import type { MealDefinitionRow } from "./_shared/types";

const DEFS_PATH = "/api/v1/admin/meal-definitions";

/** BoardOps-style cutoff preview line for the config cards. */
function cutoffPreviewLine(strategy: string, offsetDays: number | null, time: string): string {
  const formattedTime = formatHhMm(time);
  switch (strategy) {
    case "SAME_DAY":
      return `Service day, ${formattedTime}`;
    case "PREVIOUS_DAY":
      return `Previous day, ${formattedTime}`;
    case "CUSTOM_OFFSET": {
      const d = offsetDays ?? 0;
      if (d === 0) return `Service day, ${formattedTime}`;
      return `${d} day${d === 1 ? "" : "s"} before, ${formattedTime}`;
    }
    default:
      return formattedTime;
  }
}

/* ------------------------------------------------------------ wizard state */

interface DraftDef {
  name: string;
  description: string;
  icon: string;
  colorToken: string;
  mealType: string;
  scheduleStrategy: "DAILY" | "WEEKDAYS" | "ONE_TIME";
  weekdays: number[];
  specificDate: string;
  serviceStartLocal: string;
  serviceEndLocal: string;
  cutoffStrategy: "SAME_DAY" | "PREVIOUS_DAY" | "CUSTOM_OFFSET";
  cutoffOffsetDays: string;
  cutoffLocalTime: string;
  pricingStrategy: "FORMULA" | "FIXED";
  fixedPriceMinor: string;
  defaultState: "ON" | "OFF";
  defaultVisible: boolean;
  internalNotes: string;
}

function emptyDraft(): DraftDef {
  return {
    name: "",
    description: "",
    icon: "utensils",
    colorToken: "teal",
    mealType: "REGULAR",
    scheduleStrategy: "DAILY",
    weekdays: [1, 2, 3, 4, 5],
    specificDate: "",
    serviceStartLocal: "12:30",
    serviceEndLocal: "14:00",
    cutoffStrategy: "SAME_DAY",
    cutoffOffsetDays: "0",
    cutoffLocalTime: "09:00",
    pricingStrategy: "FORMULA",
    fixedPriceMinor: "",
    defaultState: "ON",
    defaultVisible: true,
    internalNotes: "",
  };
}

function draftFromDef(def: MealDefinitionRow): DraftDef {
  return {
    name: def.name,
    description: def.description ?? "",
    icon: def.icon ?? "utensils",
    colorToken: def.colorToken ?? "teal",
    mealType: def.mealType,
    scheduleStrategy: (def.scheduleStrategy as DraftDef["scheduleStrategy"]) ?? "DAILY",
    weekdays: (def.weekdaysCsv ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 7),
    specificDate: def.specificDate ?? "",
    serviceStartLocal: def.serviceStartLocal,
    serviceEndLocal: def.serviceEndLocal,
    cutoffStrategy: (def.cutoffStrategy as DraftDef["cutoffStrategy"]) ?? "SAME_DAY",
    cutoffOffsetDays: String(def.cutoffOffsetDays ?? 0),
    cutoffLocalTime: def.cutoffLocalTime,
    pricingStrategy: (def.pricingStrategy as DraftDef["pricingStrategy"]) ?? "FORMULA",
    fixedPriceMinor: def.fixedPriceMinor != null ? (def.fixedPriceMinor / 100).toFixed(2) : "",
    defaultState: def.defaultState === "OFF" ? "OFF" : "ON",
    defaultVisible: def.defaultVisible,
    internalNotes: def.internalNotes ?? "",
  };
}

const STEPS = ["Basics", "Schedule", "Cutoff", "Pricing", "Defaults", "Review"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function stepProblem(draft: DraftDef, step: number): string | null {
  switch (step) {
    case 0:
      if (draft.name.trim().length < 2) return "Give the meal a name (at least 2 characters).";
      return null;
    case 1: {
      if (!HHMM.test(draft.serviceStartLocal) || !HHMM.test(draft.serviceEndLocal))
        return "Set the service window as HH:MM.";
      if (draft.serviceStartLocal >= draft.serviceEndLocal) return "Service end must be after service start.";
      if (draft.scheduleStrategy === "WEEKDAYS" && draft.weekdays.length === 0) return "Pick at least one weekday.";
      if (draft.scheduleStrategy === "ONE_TIME" && !draft.specificDate) return "Pick the one-time date.";
      return null;
    }
    case 2:
      if (!HHMM.test(draft.cutoffLocalTime)) return "Set the cutoff time as HH:MM.";
      if (draft.cutoffStrategy === "CUSTOM_OFFSET" && !/^\d{1,2}$/.test(draft.cutoffOffsetDays.trim()))
        return "Enter the offset in days (0–30).";
      return null;
    case 3:
      if (draft.pricingStrategy === "FIXED" && moneyProblem(draft.fixedPriceMinor)) return "Enter a fixed price like 55.00.";
      return null;
    default:
      return null;
  }
}

function draftToPayload(draft: DraftDef): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    icon: draft.icon,
    colorToken: draft.colorToken,
    mealType: draft.mealType,
    defaultState: draft.defaultState,
    defaultVisible: draft.defaultVisible,
    pricingStrategy: draft.pricingStrategy,
    scheduleStrategy: draft.scheduleStrategy,
    serviceStartLocal: draft.serviceStartLocal,
    serviceEndLocal: draft.serviceEndLocal,
    cutoffStrategy: draft.cutoffStrategy,
    cutoffLocalTime: draft.cutoffLocalTime,
    internalNotes: draft.internalNotes.trim() || undefined,
  };
  if (draft.scheduleStrategy === "WEEKDAYS") {
    payload.weekdaysCsv = [...draft.weekdays].sort((a, b) => a - b).join(",");
  }
  if (draft.scheduleStrategy === "ONE_TIME") payload.specificDate = draft.specificDate;
  if (draft.cutoffStrategy === "CUSTOM_OFFSET") payload.cutoffOffsetDays = Number(draft.cutoffOffsetDays);
  if (draft.pricingStrategy === "FIXED") payload.fixedPriceMinor = draft.fixedPriceMinor.trim();
  return payload;
}

/* ----------------------------------------------------------------- wizard */

function DefinitionWizard({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: MealDefinitionRow | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<DraftDef>(() => (editing ? draftFromDef(editing) : emptyDraft()));
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const problem = stepProblem(draft, step);

  async function save() {
    setSaving(true);
    try {
      const payload = draftToPayload(draft);
      if (editing) {
        // PUT creates a NEW immutable version (merged + validated server-side).
        await api(`${DEFS_PATH}/${editing.id}`, { method: "PUT", json: payload });
      } else {
        await postJson(DEFS_PATH, payload);
      }
      toast.success(editing ? "Meal updated — new version saved" : "Meal created", {
        description: editing
          ? `${draft.name.trim()} · version snapshot recorded. Already-materialized services keep their old version.`
          : `${draft.name.trim()} · instances generate from the next service date.`,
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
    <DialogShell2
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setStep(0);
          setDraft(editing ? draftFromDef(editing) : emptyDraft());
        }
        onOpenChange(next);
      }}
      title={editing ? `Edit ${editing.name}` : "New meal"}
      description={`Step ${step + 1} of 6 — ${STEPS[step]}`}
      wide
      footer={
        <>
          <GlassButton variant="ghost" icon={<ChevronLeft />} disabled={step === 0 || saving} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </GlassButton>
          {step < 5 ? (
            <GlassButton disabled={problem != null} onClick={() => setStep((s) => Math.min(5, s + 1))}>
              {problem ? "Fix to continue" : "Continue"}
              <ChevronRight className="size-4" aria-hidden />
            </GlassButton>
          ) : (
            <GlassButton variant="primary" icon={<Check />} loading={saving} onClick={() => void save()}>
              {editing ? "Save new version" : "Create meal"}
            </GlassButton>
          )}
        </>
      }
    >
      {/* progress dots */}
      <div className="mb-5 flex items-center gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? "bg-primary" : "bg-foreground/10 dark:bg-white/10"}`}
          />
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="space-y-4"
        >
          {/* 1 — basics */}
          {step === 0 && (
            <>
              <TextField label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="e.g. Breakfast" maxLength={60} error={draft.name.trim().length > 0 && draft.name.trim().length < 2 ? "Name needs at least 2 characters." : undefined} />
              <TextAreaField label="Description (optional)" value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} rows={2} maxLength={500} placeholder="What this meal includes…" />
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Icon</p>
                <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Accent colour</p>
                <ColorTokenPicker value={draft.colorToken} onChange={(colorToken) => setDraft({ ...draft, colorToken })} />
              </div>
              <SelectField
                label="Meal type"
                value={draft.mealType}
                onChange={(mealType) => setDraft({ ...draft, mealType })}
                options={[
                  { value: "REGULAR", label: "Regular — daily service" },
                  { value: "SPECIAL", label: "Special" },
                  { value: "GUEST_ONLY", label: "Guest only" },
                  { value: "FESTIVAL", label: "Festival" },
                  { value: "CUSTOM", label: "Custom" },
                ]}
              />
            </>
          )}

          {/* 2 — schedule */}
          {step === 1 && (
            <>
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Repeats</p>
                <SegmentedControl
                  aria-label="Schedule strategy"
                  options={[
                    { value: "DAILY", label: "Daily" },
                    { value: "WEEKDAYS", label: "Weekdays" },
                    { value: "ONE_TIME", label: "One-time" },
                  ]}
                  value={draft.scheduleStrategy}
                  onChange={(v) => setDraft({ ...draft, scheduleStrategy: v as DraftDef["scheduleStrategy"] })}
                />
              </div>
              {draft.scheduleStrategy === "WEEKDAYS" && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-muted-foreground">On days</p>
                  <WeekdayPicker
                    selected={draft.weekdays}
                    onToggle={(day) =>
                      setDraft({
                        ...draft,
                        weekdays: draft.weekdays.includes(day)
                          ? draft.weekdays.filter((d) => d !== day)
                          : [...draft.weekdays, day],
                      })
                    }
                  />
                </div>
              )}
              {draft.scheduleStrategy === "ONE_TIME" && (
                <TextField label="Service date" type="date" value={draft.specificDate} onChange={(specificDate) => setDraft({ ...draft, specificDate })} />
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <TextField label="Service starts" type="time" value={draft.serviceStartLocal} onChange={(serviceStartLocal) => setDraft({ ...draft, serviceStartLocal })} />
                <TextField label="Service ends" type="time" value={draft.serviceEndLocal} onChange={(serviceEndLocal) => setDraft({ ...draft, serviceEndLocal })} />
              </div>
            </>
          )}

          {/* 3 — cutoff */}
          {step === 2 && (
            <>
              <SelectField
                label="Cutoff strategy"
                value={draft.cutoffStrategy}
                onChange={(cutoffStrategy) => setDraft({ ...draft, cutoffStrategy: cutoffStrategy as DraftDef["cutoffStrategy"] })}
                options={[
                  { value: "SAME_DAY", label: "Same day" },
                  { value: "PREVIOUS_DAY", label: "Previous day" },
                  { value: "CUSTOM_OFFSET", label: "Custom offset" },
                ]}
              />
              {draft.cutoffStrategy === "CUSTOM_OFFSET" && (
                <TextField label="Offset (days before service)" value={draft.cutoffOffsetDays} inputMode="numeric" onChange={(cutoffOffsetDays) => setDraft({ ...draft, cutoffOffsetDays })} placeholder="0" />
              )}
              <TextField label="Cutoff time" type="time" value={draft.cutoffLocalTime} onChange={(cutoffLocalTime) => setDraft({ ...draft, cutoffLocalTime })} />
              <div className="glass-inset flex items-start gap-2.5 rounded-md p-3.5">
                <Clock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  {cutoffPlainWords(draft.cutoffStrategy, Number(draft.cutoffOffsetDays) || 0, draft.cutoffLocalTime || "—")}
                </p>
              </div>
            </>
          )}

          {/* 4 — pricing */}
          {step === 3 && (
            <>
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Pricing</p>
                <SegmentedControl
                  aria-label="Pricing strategy"
                  options={[
                    { value: "FORMULA", label: "From formula" },
                    { value: "FIXED", label: "Fixed price" },
                  ]}
                  value={draft.pricingStrategy}
                  onChange={(v) => setDraft({ ...draft, pricingStrategy: v as DraftDef["pricingStrategy"] })}
                />
              </div>
              {draft.pricingStrategy === "FIXED" ? (
                <MoneyField label="Price per meal" value={draft.fixedPriceMinor} onChange={(fixedPriceMinor) => setDraft({ ...draft, fixedPriceMinor })} placeholder="55.00" error={moneyProblem(draft.fixedPriceMinor) ?? undefined} />
              ) : (
                <div className="glass-inset rounded-md p-3.5 text-[12px] leading-relaxed text-muted-foreground">
                  The charge per meal is computed each billing period by the active formula (see the Formula page). Every
                  resident pays the same computed amount for this meal.
                </div>
              )}
            </>
          )}

          {/* 5 — defaults */}
          {step === 4 && (
            <>
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Default state for new residents</p>
                <SegmentedControl
                  aria-label="Default state"
                  options={[
                    { value: "ON", label: "Opted in" },
                    { value: "OFF", label: "Opted out" },
                  ]}
                  value={draft.defaultState}
                  onChange={(v) => setDraft({ ...draft, defaultState: v as DraftDef["defaultState"] })}
                />
              </div>
              <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  {draft.defaultVisible ? <Eye className="size-4 shrink-0 text-primary" aria-hidden /> : <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Visible to residents</p>
                    <p className="text-[11px] text-muted-foreground">Hidden meals stay admin-only.</p>
                  </div>
                </div>
                <GlassToggle
                  checked={draft.defaultVisible}
                  onChange={(next) => setDraft({ ...draft, defaultVisible: next })}
                  label="Visible to residents"
                />
              </div>
              <TextAreaField label="Internal notes (optional)" value={draft.internalNotes} onChange={(internalNotes) => setDraft({ ...draft, internalNotes })} rows={2} maxLength={1000} placeholder="Kitchen notes, not shown to residents…" />
            </>
          )}

          {/* 6 — review */}
          {step === 5 && (
            <div className="space-y-3">
              <div className="glass-inset rounded-md p-4">
                <div className="mb-2 flex items-center gap-3">
                  <span className="glass-inset flex size-10 items-center justify-center rounded-md text-primary [&_svg]:size-[18px]">
                    {(() => {
                      const Icon = mealIcon(draft.icon);
                      return <Icon aria-hidden />;
                    })()}
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{draft.name.trim() || "—"}</p>
                    <p className="text-[11px] text-muted-foreground">{draft.mealType}</p>
                  </div>
                </div>
                <KeyValue label="Schedule" value={scheduleLabel(draft.scheduleStrategy, draft.weekdays.join(","), draft.specificDate)} />
                <KeyValue label="Service window" value={`${formatHhMm(draft.serviceStartLocal)} – ${formatHhMm(draft.serviceEndLocal)}`} />
                <KeyValue label="Cutoff" value={cutoffPlainWords(draft.cutoffStrategy, Number(draft.cutoffOffsetDays) || 0, draft.cutoffLocalTime || "—")} />
                <KeyValue label="Pricing" value={draft.pricingStrategy === "FIXED" ? "Fixed price" : "Computed from formula"} />
                {draft.pricingStrategy === "FIXED" && (
                  <KeyValue label="Fixed price" value={draft.fixedPriceMinor ? `₹${draft.fixedPriceMinor}` : "—"} />
                )}
                <KeyValue label="Default state" value={draft.defaultState === "ON" ? "Opted in" : "Opted out"} />
                <KeyValue label="Visible" value={draft.defaultVisible ? "Yes" : "Hidden"} />
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {editing
                  ? "Saving creates a new immutable version. Services already generated keep their current version."
                  : "New instances generate from the next matching service date."}
              </p>
            </div>
          )}

          {problem && step < 5 && (
            <p className="text-[12px] font-medium text-warning">{problem}</p>
          )}
        </motion.div>
      </AnimatePresence>
    </DialogShell2>
  );
}

/* ------------------------------------------------------------------- view */

export default function AdminMealConfiguration() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingDef, setEditingDef] = useState<MealDefinitionRow | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<MealDefinitionRow | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<MealDefinitionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MealDefinitionRow | null>(null);
  const [cancelDeletionTarget, setCancelDeletionTarget] = useState<MealDefinitionRow | null>(null);
  const [acting, setActing] = useState(false);
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  const { data: envelope, isLoading, error, refetch } = useApiMetaQuery<MealDefinitionRow[]>(DEFS_PATH);
  const defs = envelope?.data ?? [];
  const meta = envelope?.meta ?? {};

  const detailQuery = useApiQuery<MealDefinitionRow>(detailId ? `${DEFS_PATH}/${detailId}` : null);
  const detail = detailQuery.data;

  async function archive(target: MealDefinitionRow) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/archive`, {});
      invalidate([DEFS_PATH]);
      toast.success("Meal archived", {
        description: `${target.name} stops generating future services. History stays intact.`,
      });
      setArchiveTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function requestDeletion(target: MealDefinitionRow, reason: string | undefined) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/request-deletion`, { reason });
      invalidate([DEFS_PATH]);
      toast.success("Deletion scheduled", {
        description: `${target.name} is archived now and leaves live configuration after the 30-day safety window.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function restore(target: MealDefinitionRow) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/restore`, {});
      invalidate([DEFS_PATH]);
      toast.success("Meal restored", {
        description: `${target.name} can generate future matching services again.`,
      });
      setRestoreTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function cancelDeletion(target: MealDefinitionRow, reason: string | undefined) {
    setActing(true);
    try {
      await postJson(`${DEFS_PATH}/${target.id}/cancel-deletion`, { reason });
      invalidate([DEFS_PATH]);
      toast.success("Deletion cancelled", {
        description: `${target.name} remains archived. Restore it separately if it should return to service.`,
      });
      setCancelDeletionTarget(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  if (isLoading && !envelope) {
    return (
      <div className="space-y-4">
        <KpiGridSkeleton count={3} />
        <ListSkeleton rows={3} />
      </div>
    );
  }

  if (error || !envelope) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={(error as ApiClientError | undefined)?.code}
          message={(error as ApiClientError | undefined)?.message}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <StaggerGroup className="space-y-4">
      {/* KPI cards — 3 columns matching meals page exactly and centered */}
      <StaggerItem>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <KpiCard
          label="Total"
          value={String(metaNum(meta, "configured") ?? defs.length)}
          sub="Definitions"
          icon={<Settings2 />}
          glow="primary"
          tone="primary"
          index={0}
        />
        <KpiCard
          label="Active"
          value={String(metaNum(meta, "active") ?? "—")}
          sub="In service"
          icon={<Utensils />}
          glow="success"
          tone="success"
          index={1}
        />
        <KpiCard
          label="Inactive"
          value={String(metaNum(meta, "inactive") ?? "—")}
          sub="Archived"
          icon={<Archive />}
          glow="warning"
          tone="warning"
          index={2}
        />
      </div>
      </StaggerItem>

      {/* Action bar — primary create action centered after KPIs */}
      <StaggerItem>
      <div className="flex items-center justify-center">
        <GlassButton
          variant="primary"
          icon={<Plus />}
          onClick={() => {
            setEditingDef(null);
            setWizardOpen(true);
          }}
        >
          New Meal
        </GlassButton>
      </div>
      </StaggerItem>

      <StaggerItem>
      {defs.length === 0 ? (
        <EmptyState
          icon={Utensils}
          title="No meals configured"
          description="Create your first meal definition — residents see and opt into meals from here."
          action={
            <GlassButton variant="primary" icon={<Plus />} onClick={() => setWizardOpen(true)}>
              New Meal
            </GlassButton>
          }
        />
      ) : (
        <div className="grid-cards gap-3">
          <AnimatePresence initial={false}>
            {defs.map((def) => {
              const Icon = mealIcon(def.icon);
              const inactive = def.archivedAt != null;
              const deletionPending = ["QUEUED", "SCHEDULED", "BLOCKED"].includes(def.deletionRequest?.status ?? "");
              const hex = mealHex(def.colorToken);
              return (
                <motion.div
                  key={def.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  whileHover={{ y: -4, scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  transition={SPRING_SNAPPY}
                  className="glass relative flex flex-col overflow-hidden rounded-3xl p-4"
                  style={{
                    background: `linear-gradient(135deg, ${hex}2e 0%, ${hex}0a 55%, transparent 100%)`,
                    borderColor: `${hex}50`,
                    boxShadow: `0 8px 32px -10px ${hex}40, inset 0 1px 0 0 ${hex}22`,
                  }}
                >
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full opacity-40 blur-3xl"
                    style={{ background: hex }}
                  />

                  {/* Color accent bar */}
                  <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: hex }} />

                  <div className="relative z-10 flex flex-col gap-2.5">
                    {/* Top row: Orb + Name & Service Window (Left), Price & Status (Right) */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          aria-hidden
                          className="flex size-11 shrink-0 items-center justify-center rounded-xl border"
                          style={{ backgroundColor: `${hex}1f`, borderColor: `${hex}44`, color: hex }}
                        >
                          <Icon className="size-5" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-base sm:text-lg font-bold text-foreground tracking-tight">
                            {def.name}
                          </h3>
                          <p className="kpi-num mt-0.5 text-xs font-medium text-muted-foreground">
                            {formatHhMm(def.serviceStartLocal)} – {formatHhMm(def.serviceEndLocal)}
                            <span className="mx-1.5 opacity-40">·</span>
                            {scheduleLabel(def.scheduleStrategy, def.weekdaysCsv, def.specificDate)}
                          </p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="flex items-baseline justify-end gap-1">
                          {def.pricingStrategy === "FIXED" ? (
                            <span className="kpi-num text-xl sm:text-2xl font-extrabold text-foreground tracking-tight leading-none">
                              <Money minor={def.fixedPriceMinor ?? 0} />
                            </span>
                          ) : (
                            <span className="text-xs font-bold text-foreground">Formula</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center justify-end">
                          <StatusBadge status={deletionPending ? "PENDING_DELETION" : inactive ? "INACTIVE" : "ACTIVE"} />
                        </div>
                      </div>
                    </div>

                    {/* Bottom row: Cutoff & Default state badges + Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/20 pt-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-xl bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
                          <Clock className="size-3" aria-hidden />
                          <span>Cutoff: {cutoffPreviewLine(def.cutoffStrategy, def.cutoffOffsetDays, def.cutoffLocalTime)}</span>
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-xl bg-foreground/5 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          Default: <strong className="font-semibold text-foreground">{def.defaultState === "ON" ? "Opted in" : "Opted out"}</strong>
                        </span>
                        {!def.defaultVisible && (
                          <span className="rounded-xl bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                            Hidden
                          </span>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="ml-auto flex items-center gap-1.5">
                        {!deletionPending && (
                          <ViewButton
                            label="Edit"
                            onClick={() => {
                              setEditingDef(def);
                              setWizardOpen(true);
                            }}
                          />
                        )}
                        <OverflowMenu
                          label={`Actions for ${def.name}`}
                          actions={[
                            { key: "history", label: "Version history", icon: <History />, onSelect: () => setDetailId(def.id) },
                            ...(!deletionPending
                              ? [{
                                  key: "edit",
                                  label: "Edit (new version)",
                                  icon: <Settings2 />,
                                  onSelect: () => {
                                    setEditingDef(def);
                                    setWizardOpen(true);
                                  },
                                  separatorBefore: true,
                                }]
                              : []),
                            ...(!deletionPending && !inactive
                              ? [{ key: "archive", label: "Archive", icon: <Archive />, onSelect: () => setArchiveTarget(def), separatorBefore: true }]
                              : []),
                            ...(!deletionPending && inactive
                              ? [{ key: "restore", label: "Restore", icon: <RotateCcw />, onSelect: () => setRestoreTarget(def), separatorBefore: true }]
                              : []),
                            ...(deletionPending
                              ? [{ key: "cancel-delete", label: "Cancel deletion…", icon: <RotateCcw />, onSelect: () => setCancelDeletionTarget(def), separatorBefore: true }]
                              : [{ key: "delete", label: "Request deletion…", icon: <Trash2 />, onSelect: () => setDeleteTarget(def), destructive: true }]),
                          ]}
                        />
                      </div>
                    </div>

                    {deletionPending && (
                      <p className="rounded-md bg-danger/10 px-2.5 py-1 text-[11px] font-medium text-danger">
                        {def.deletionRequest?.status === "BLOCKED"
                          ? `Deletion blocked — ${def.deletionRequest.blockedReason ?? "Needs Admin review"}`
                          : `Deletion scheduled${def.deletionRequest?.scheduledFor ? ` — ${fmtDate(def.deletionRequest.scheduledFor)}` : ""}`}
                      </p>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
      </StaggerItem>

      {/* wizard */}
      {wizardOpen && (
        <DefinitionWizard
          open
          onOpenChange={(open) => {
            if (!open) {
              setWizardOpen(false);
              setEditingDef(null);
            }
          }}
          editing={editingDef}
          onSaved={() => invalidate([DEFS_PATH, detailId ? `${DEFS_PATH}/${detailId}` : DEFS_PATH])}
        />
      )}

      {/* version history dialog */}
      {detailId && (
        <DialogShell2
          open
          onOpenChange={(open) => !open && setDetailId(null)}
          title={detail ? `${detail.name} — versions` : "Version history"}
          description="Each edit snapshots the full configuration. Materialized services keep the version they were generated with."
          wide
        >
          {detailQuery.isLoading ? (
            <ListSkeleton rows={3} />
          ) : !detail ? (
            <ErrorState code={detailQuery.error ? (detailQuery.error as ApiClientError).code : undefined} message="This meal definition could not be found." onRetry={undefined} />
          ) : (
            <div className="space-y-2">
              {(detail.versions ?? []).map((v) => (
                <div key={v.id} className="glass-inset rounded-md p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold">Version {v.version}</p>
                    <span className="kpi-num text-[11px] text-muted-foreground">{fmtDateTime(v.createdAt, tz)}</span>
                  </div>
                  {v.configSnapshot && (
                    <div className="mt-1.5 grid grid-cols-2 gap-x-4 text-[12px] text-muted-foreground">
                      <span>Name: {String((v.configSnapshot as Record<string, unknown>).name ?? "—")}</span>
                      <span>Window: {formatHhMm(String((v.configSnapshot as Record<string, unknown>).serviceStartLocal ?? "—"))} – {formatHhMm(String((v.configSnapshot as Record<string, unknown>).serviceEndLocal ?? "—"))}</span>
                      <span>Cutoff: {formatHhMm(String((v.configSnapshot as Record<string, unknown>).cutoffLocalTime ?? "—"))}</span>
                      <span>Pricing: {String((v.configSnapshot as Record<string, unknown>).pricingStrategy ?? "—")}</span>
                    </div>
                  )}
                </div>
              ))}
              {(detail.versions ?? []).length === 0 && <p className="text-[13px] text-muted-foreground">No versions recorded yet.</p>}
            </div>
          )}
        </DialogShell2>
      )}

      {/* archive confirm */}
      {archiveTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setArchiveTarget(null)}
          title={`Archive ${archiveTarget.name}`}
          description="Future services stop being generated. Residents' existing meals and all history stay intact. Restore the meal explicitly if it should return to service."
          confirmLabel="Archive meal"
          tone="destructive"
          loading={acting}
          onConfirm={() => void archive(archiveTarget)}
        />
      )}

      {/* restore archive */}
      {restoreTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRestoreTarget(null)}
          title={`Restore ${restoreTarget.name}`}
          description="This reactivates the definition so future matching services may be generated again. Historical service versions remain unchanged."
          confirmLabel="Restore meal"
          tone="primary"
          loading={acting}
          onConfirm={() => void restore(restoreTarget)}
        />
      )}

      {/* deletion queue */}
      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={`Request deletion — ${deleteTarget.name}`}
          description="This archives the meal immediately, then schedules a tombstone after a 30-day safety window. The definition's versions and historical meal records are never destroyed."
          confirmLabel="Schedule deletion"
          tone="destructive"
          requireReason
          reasonPlaceholder="Why is this meal being removed? (required)"
          loading={acting}
          onConfirm={(reason) => void requestDeletion(deleteTarget, reason)}
        />
      )}

      {cancelDeletionTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setCancelDeletionTarget(null)}
          title={`Cancel deletion — ${cancelDeletionTarget.name}`}
          description="The deletion request stays in history as CANCELLED. The meal remains archived until you explicitly restore it."
          confirmLabel="Cancel deletion"
          tone="destructive"
          requireReason
          reasonPlaceholder="Why is this deletion being cancelled? (required)"
          loading={acting}
          onConfirm={(reason) => void cancelDeletion(cancelDeletionTarget, reason)}
        />
      )}
    </StaggerGroup>
  );
}

/* ------------------------------------------------------------ dialog shell */

function DialogShell2({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("glass-strong rounded-2xl border-0 p-0", wide ? "sm:max-w-2xl" : "sm:max-w-md")}>
        <div className="flex max-h-[85vh] flex-col">
          <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">{title}</DialogTitle>
            {description && (
              <DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </DialogDescription>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
          {footer && (
            <div className="safe-b flex flex-wrap items-center justify-end gap-2 border-t border-border/50 px-5 py-4 sm:px-6">
              {footer}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
