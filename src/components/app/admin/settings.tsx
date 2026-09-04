"use client";

/**
 * Admin Settings — BoardOps settings-hub composition: grouped GlassCard
 * sections with tinted icon tiles (institution=primary, financial policy=
 * warning, billing=success, security=danger), glass-inset setting rows,
 * per-section local drafts + save with dirty-state indicators and
 * audit-friendly toasts, versioned policy publishing, live theme switch.
 * GET/PATCH /api/v1/admin/settings · GET/POST /api/v1/admin/policies
 */

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import {
  Banknote,
  Building2,
  Check,
  FileText,
  Lock,
  Palette,
  Plus,
  ScrollText,
  Utensils,
} from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import SegmentedControl from "@/components/glass/SegmentedControl";
import GlassToggle from "@/components/glass/GlassToggle";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useApiQuery, postJson, patchJson } from "@/hooks/use-api-query";
import { useMounted } from "@/hooks/use-mounted";
import { ApiClientError } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errMessage, useInvalidate } from "./_shared/api";
import { MoneyField, SelectField, TextAreaField, TextField, moneyProblem } from "./_shared/fields";
import { CollapseRow } from "./_shared/chrome";
import { fmtDate } from "./_shared/format";
import type { AdminSettings, PolicyRow } from "./_shared/types";
import { cn } from "@/lib/utils";

const SETTINGS_PATH = "/api/v1/admin/settings";
const POLICIES_PATH = "/api/v1/admin/policies";

function minorToInput(minor: number): string {
  return (minor / 100).toFixed(2);
}

/* ------------------------- settings-hub group card ------------------------ */

type SectionTone = "primary" | "success" | "warning" | "danger" | "frost";

const SECTION_TONES: Record<SectionTone, string> = {
  primary: "border-primary/25 bg-primary/15 text-primary",
  success: "border-success/25 bg-success/15 text-success",
  warning: "border-warning/25 bg-warning/15 text-warning",
  danger: "border-danger/25 bg-danger/15 text-danger",
  frost: "border-primary/20 bg-primary/10 text-primary",
};

/** BoardOps settings-hub group: tinted icon tile + title + action slot. */
function GroupCard({
  icon,
  tone = "primary",
  title,
  description,
  action,
  dirty,
  children,
}: {
  icon: React.ReactNode;
  tone?: SectionTone;
  title: string;
  description?: string;
  action?: React.ReactNode;
  dirty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <GlassCard className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "relative flex size-10 shrink-0 items-center justify-center rounded-md border [&_svg]:size-[18px]",
              SECTION_TONES[tone]
            )}
          >
            {icon}
            {dirty && (
              <span aria-hidden className="absolute -right-1 -top-1 size-2.5 rounded-full bg-warning ring-2 ring-border" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </GlassCard>
  );
}

/** Generic settings section with a local draft + save button. */
function SettingsSection({
  icon,
  tone,
  title,
  description,
  saving,
  dirty,
  onSave,
  children,
}: {
  icon: React.ReactNode;
  tone?: SectionTone;
  title: string;
  description?: string;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <GroupCard
      icon={icon}
      tone={tone}
      title={title}
      description={description}
      dirty={dirty}
      action={
        <GlassButton variant={dirty ? "primary" : "secondary"} size="sm" icon={dirty ? <Check /> : undefined} loading={saving} disabled={!dirty} onClick={onSave}>
          {dirty ? "Save changes" : "Saved"}
        </GlassButton>
      }
    >
      {children}
    </GroupCard>
  );
}

export default function AdminSettings() {
  const { data, isLoading, error, refetch } = useApiQuery<AdminSettings>(SETTINGS_PATH);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const invalidate = useInvalidate();

  /* drafts */
  const [instDraft, setInstDraft] = useState({ name: "", timezone: "" });
  const [policyDraft, setPolicyDraft] = useState({
    deficitThreshold: "",
    gracePeriodDays: "",
    restrictMealsOnDeficit: true,
    deficitPolicyEnabled: true,
    guestMealPrice: "",
  });
  const [billingDraft, setBillingDraft] = useState({ billingDueDays: "" });
  const [securityDraft, setSecurityDraft] = useState({
    maxLoginAttempts: "",
    loginWindowMinutes: "",
    requireReasonOnOverride: true,
  });

  useEffect(() => {
    if (!data) return;
    setInstDraft({ name: data.institution.name, timezone: data.institution.timezone });
    setPolicyDraft({
      deficitThreshold: minorToInput(data.settings.deficitThresholdMinor),
      gracePeriodDays: String(data.settings.gracePeriodDays),
      restrictMealsOnDeficit: data.settings.restrictMealsOnDeficit,
      deficitPolicyEnabled: data.settings.deficitPolicyEnabled,
      guestMealPrice: minorToInput(data.settings.guestMealPriceMinor),
    });
    setBillingDraft({ billingDueDays: String(data.settings.billingDueDays) });
    setSecurityDraft({
      maxLoginAttempts: String(data.security.maxLoginAttempts),
      loginWindowMinutes: String(data.security.loginWindowMinutes),
      requireReasonOnOverride: data.security.requireReasonOnOverride,
    });
  }, [data]);

  /* dirty flags */
  const instDirty =
    !!data && (instDraft.name !== data.institution.name || instDraft.timezone !== data.institution.timezone);
  const policyDirty =
    !!data &&
    (policyDraft.deficitThreshold !== minorToInput(data.settings.deficitThresholdMinor) ||
      policyDraft.gracePeriodDays !== String(data.settings.gracePeriodDays) ||
      policyDraft.restrictMealsOnDeficit !== data.settings.restrictMealsOnDeficit ||
      policyDraft.deficitPolicyEnabled !== data.settings.deficitPolicyEnabled ||
      policyDraft.guestMealPrice !== minorToInput(data.settings.guestMealPriceMinor));
  const billingDirty = !!data && billingDraft.billingDueDays !== String(data.settings.billingDueDays);
  const securityDirty =
    !!data &&
    (securityDraft.maxLoginAttempts !== String(data.security.maxLoginAttempts) ||
      securityDraft.loginWindowMinutes !== String(data.security.loginWindowMinutes) ||
      securityDraft.requireReasonOnOverride !== data.security.requireReasonOnOverride);

  async function patch(section: string, payload: Record<string, unknown>, changedLabels: string[]) {
    setSavingSection(section);
    try {
      await patchJson(SETTINGS_PATH, payload);
      invalidate([SETTINGS_PATH]);
      toast.success("Settings saved", {
        description: changedLabels.length > 0 ? `Changed: ${changedLabels.join(", ")}.` : undefined,
      });
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSavingSection(null);
    }
  }

  /* policies */
  const policiesQuery = useApiQuery<PolicyRow[]>(POLICIES_PATH);
  const [policyFormOpen, setPolicyFormOpen] = useState(false);

  /* theme */
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (error || !data) {
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
      {/* ------------------------------------------------- institution */}
      <StaggerItem>
      <SettingsSection
        icon={<Building2 />}
        tone="primary"
        title="Institution"
        description="Displayed across the app and drives server-side timezone math."
        saving={savingSection === "institution"}
        dirty={instDirty}
        onSave={() =>
          void patch(
            "institution",
            { name: instDraft.name.trim(), timezone: instDraft.timezone.trim() },
            [
              ...(instDraft.name !== data.institution.name ? ["name"] : []),
              ...(instDraft.timezone !== data.institution.timezone ? ["timezone"] : []),
            ]
          )
        }
      >
        <TextField label="Institution name" value={instDraft.name} onChange={(name) => setInstDraft({ ...instDraft, name })} maxLength={120} />
        <TextField
          label="Timezone"
          value={instDraft.timezone}
          onChange={(timezone) => setInstDraft({ ...instDraft, timezone })}
          placeholder="Asia/Kolkata"
          hint="IANA timezone — used for cutoffs, billing months and the clock in the footer."
        />
        <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
          <span className="text-[13px] font-medium">Currency</span>
          <span className="kpi-num text-sm font-semibold">{data.institution.currencyCode}</span>
        </div>
      </SettingsSection>
      </StaggerItem>

      {/* ------------------------------------------------- meals & policies */}
      <StaggerItem>
      <SettingsSection
        icon={<Utensils />}
        tone="warning"
        title="Meals & Financial Policy"
        description="Deficit thresholds and the guest meal price."
        saving={savingSection === "policy"}
        dirty={policyDirty}
        onSave={() => {
          const changed: string[] = [];
          if (policyDraft.deficitThreshold !== minorToInput(data.settings.deficitThresholdMinor)) changed.push("deficit threshold");
          if (policyDraft.gracePeriodDays !== String(data.settings.gracePeriodDays)) changed.push("grace days");
          if (policyDraft.restrictMealsOnDeficit !== data.settings.restrictMealsOnDeficit) changed.push("meal restriction");
          if (policyDraft.deficitPolicyEnabled !== data.settings.deficitPolicyEnabled) changed.push("deficit policy");
          if (policyDraft.guestMealPrice !== minorToInput(data.settings.guestMealPriceMinor)) changed.push("guest price");
          void patch(
            "policy",
            {
              settings: {
                deficitThresholdMinor: policyDraft.deficitThreshold.trim(),
                gracePeriodDays: Number(policyDraft.gracePeriodDays) || 0,
                restrictMealsOnDeficit: policyDraft.restrictMealsOnDeficit,
                deficitPolicyEnabled: policyDraft.deficitPolicyEnabled,
                guestMealPriceMinor: policyDraft.guestMealPrice.trim(),
              },
            },
            changed
          );
        }}
      >
        <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
          <MoneyField
            label="Deficit threshold"
            value={policyDraft.deficitThreshold}
            onChange={(deficitThreshold) => setPolicyDraft({ ...policyDraft, deficitThreshold })}
            hint="Below this available balance the deficit policy kicks in."
          />
          <TextField
            label="Grace days"
            value={policyDraft.gracePeriodDays}
            inputMode="numeric"
            onChange={(gracePeriodDays) => setPolicyDraft({ ...policyDraft, gracePeriodDays })}
            hint="Days after the oldest unsettled bill."
          />
          <MoneyField
            label="Guest meal price"
            value={policyDraft.guestMealPrice}
            onChange={(guestMealPrice) => setPolicyDraft({ ...policyDraft, guestMealPrice })}
            hint="Fixed price charged per guest meal."
          />
        </div>
        <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Restrict meals on deficit</p>
            <p className="text-[11px] text-muted-foreground">Meals become unavailable below the threshold after grace.</p>
          </div>
          <GlassToggle
            checked={policyDraft.restrictMealsOnDeficit}
            onChange={(restrictMealsOnDeficit) => setPolicyDraft({ ...policyDraft, restrictMealsOnDeficit })}
            label="Restrict meals on deficit"
          />
        </div>
        <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Deficit policy enabled</p>
            <p className="text-[11px] text-muted-foreground">Turn the whole deficit/grace machinery on or off.</p>
          </div>
          <GlassToggle
            checked={policyDraft.deficitPolicyEnabled}
            onChange={(deficitPolicyEnabled) => setPolicyDraft({ ...policyDraft, deficitPolicyEnabled })}
            label="Deficit policy enabled"
          />
        </div>
        {moneyProblem(policyDraft.deficitThreshold) && <p className="text-[11px] font-medium text-danger">Deficit threshold: {moneyProblem(policyDraft.deficitThreshold)}</p>}
        {moneyProblem(policyDraft.guestMealPrice) && <p className="text-[11px] font-medium text-danger">Guest price: {moneyProblem(policyDraft.guestMealPrice)}</p>}
      </SettingsSection>
      </StaggerItem>

      {/* ------------------------------------------------- billing */}
      <StaggerItem>
      <SettingsSection
        icon={<Banknote />}
        tone="success"
        title="Billing"
        description="How quickly generated bills fall due."
        saving={savingSection === "billing"}
        dirty={billingDirty}
        onSave={() => void patch("billing", { settings: { billingDueDays: Number(billingDraft.billingDueDays) || 0 } }, ["due days"])}
      >
        <TextField
          label="Bills due after (days)"
          value={billingDraft.billingDueDays}
          inputMode="numeric"
          onChange={(billingDueDays) => setBillingDraft({ billingDueDays })}
          hint="Days between bill generation and the due date."
        />
      </SettingsSection>
      </StaggerItem>

      {/* ------------------------------------------------- security */}
      <StaggerItem>
      <SettingsSection
        icon={<Lock />}
        tone="danger"
        title="Security"
        description="Login limits and admin override discipline."
        saving={savingSection === "security"}
        dirty={securityDirty}
        onSave={() =>
          void patch(
            "security",
            {
              security: {
                maxLoginAttempts: Number(securityDraft.maxLoginAttempts) || 8,
                loginWindowMinutes: Number(securityDraft.loginWindowMinutes) || 15,
                requireReasonOnOverride: securityDraft.requireReasonOnOverride,
              },
            },
            [
              ...(securityDraft.maxLoginAttempts !== String(data.security.maxLoginAttempts) ? ["login attempts"] : []),
              ...(securityDraft.loginWindowMinutes !== String(data.security.loginWindowMinutes) ? ["login window"] : []),
              ...(securityDraft.requireReasonOnOverride !== data.security.requireReasonOnOverride ? ["override reason"] : []),
            ]
          )
        }
      >
        <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
          <TextField label="Max login attempts" value={securityDraft.maxLoginAttempts} inputMode="numeric" onChange={(maxLoginAttempts) => setSecurityDraft({ ...securityDraft, maxLoginAttempts })} />
          <TextField label="Login window (minutes)" value={securityDraft.loginWindowMinutes} inputMode="numeric" onChange={(loginWindowMinutes) => setSecurityDraft({ ...securityDraft, loginWindowMinutes })} />
        </div>
        <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Require reason on override</p>
            <p className="text-[11px] text-muted-foreground">Admins must write a reason when overriding a locked meal.</p>
          </div>
          <GlassToggle
            checked={securityDraft.requireReasonOnOverride}
            onChange={(requireReasonOnOverride) => setSecurityDraft({ ...securityDraft, requireReasonOnOverride })}
            label="Require reason on override"
          />
        </div>
      </SettingsSection>
      </StaggerItem>

      {/* ------------------------------------------------- policies */}
      <StaggerItem>
      <GroupCard
        icon={<ScrollText aria-hidden />}
        tone="frost"
        title="Policies"
        description="Terms residents accept — versioned, immutable."
        action={
          <GlassButton variant="secondary" size="sm" icon={<Plus />} onClick={() => setPolicyFormOpen(true)}>
            Publish new version
          </GlassButton>
        }
      >
        {policiesQuery.isLoading ? (
          <ListSkeleton rows={2} />
        ) : (policiesQuery.data ?? []).length === 0 ? (
          <EmptyState icon={ScrollText} title="No policies yet" description="Publish terms of service and house rules so new residents can accept them." />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {(policiesQuery.data ?? []).map((p) => (
              <CollapseRow key={p.id} label={`${p.title} · v${p.latestVersion?.version ?? 1}`}>
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{p.content}</p>
                <div className="mt-2.5 space-y-1">
                  {p.versions
                    .slice()
                    .sort((a, b) => b.version - a.version)
                    .map((v) => (
                      <p key={v.id} className="kpi-num text-[11px] text-muted-foreground/80">
                        v{v.version} · published {fmtDate(v.publishedAt)}
                      </p>
                    ))}
                </div>
              </CollapseRow>
            ))}
          </div>
        )}
      </GroupCard>
      </StaggerItem>

      {/* ------------------------------------------------- appearance */}
      <StaggerItem>
      <GroupCard
        icon={<Palette aria-hidden />}
        tone="primary"
        title="Appearance"
        description="Theme applies immediately — no reload."
      >
        <SegmentedControl
          aria-label="Theme mode"
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          value={mounted ? (theme ?? "system") : "system"}
          onChange={(v) => {
            setTheme(v);
            toast.success("Theme updated", { description: v === "system" ? "Following your device." : `${v} mode.` });
          }}
        />
      </GroupCard>
      </StaggerItem>

      {/* policy publish form */}
      {policyFormOpen && (
        <PolicyPublishDialog
          open
          onOpenChange={setPolicyFormOpen}
          policies={policiesQuery.data ?? []}
          onSaved={() => invalidate([POLICIES_PATH])}
        />
      )}
    </StaggerGroup>
  );
}

/* -------------------------------------------------------- policy publish */

function PolicyPublishDialog({
  open,
  onOpenChange,
  policies,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policies: PolicyRow[];
  onSaved: () => void;
}) {
  const [type, setType] = useState("TERMS_OF_SERVICE");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const valid = title.trim().length >= 2 && content.trim().length >= 10;

  async function submit() {
    setSaving(true);
    setFields({});
    try {
      await postJson(POLICIES_PATH, {
        type,
        title: title.trim(),
        content: content.trim(),
      });
      toast.success("Policy published", {
        description: "New residents accept this version at sign-up; existing acceptances stay on their original version.",
      });
      onSaved();
      onOpenChange(false);
      setTitle("");
      setContent("");
    } catch (err) {
      if (err instanceof ApiClientError && err.fields) setFields(err.fields);
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const existingTitle = useMemo(
    () => policies.find((p) => p.type === type)?.title ?? "",
    [policies, type]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong rounded-2xl border-0 p-0 sm:max-w-lg">
        <div className="flex max-h-[85vh] flex-col">
          <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">Publish policy version</DialogTitle>
            <DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">
              Versions are immutable. Publishing with the same type and title bumps the version; a new title creates a
              separate policy.
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
            <div className="space-y-4">
              <SelectField
                label="Policy type"
                value={type}
                onChange={setType}
                options={[
                  { value: "TERMS_OF_SERVICE", label: "Terms of Service" },
                  { value: "PRIVACY", label: "Privacy Notice" },
                  { value: "HOUSE_RULES", label: "House Rules" },
                  { value: "MEAL_POLICY", label: "Meal Policy" },
                ]}
              />
              <TextField
                label="Title"
                value={title}
                onChange={setTitle}
                placeholder={existingTitle || "e.g. Meal & House Rules"}
                maxLength={120}
                error={fields.title}
              />
              <TextAreaField
                label="Content"
                value={content}
                onChange={setContent}
                rows={8}
                maxLength={100000}
                placeholder="Write the policy in plain language…"
                error={fields.content}
              />
            </div>
          </div>
          <div className="safe-b flex items-center justify-end gap-2 border-t border-border/50 px-5 py-4 sm:px-6">
            <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </GlassButton>
            <GlassButton variant="primary" icon={<FileText />} loading={saving} disabled={!valid} onClick={() => void submit()}>
              Publish version
            </GlassButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
