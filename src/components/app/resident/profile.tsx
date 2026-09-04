"use client";

/**
 * Resident Profile (#/app/profile) — BoardOps profile-view composition on
 * the Aurora glass theme: StaggerGroup entrance; hero card (default glass,
 * ambient blur blobs, gradient avatar via gradientForName, centered
 * name/email + badge row, Edit action); then a 2-up grid of grouped
 * GlassCards (contact · membership · session) with glass-inset info rows.
 * View + edit flow (react-hook-form → PATCH /api/v1/me/profile) and the
 * sign-out flow kept exactly from the original build.
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  Building2,
  Check,
  DoorOpen,
  LogOut,
  Mail,
  MapPin,
  Pencil,
  Phone,
  ShieldCheck,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";

import { useSession } from "@/hooks/use-session";
import { useApiQuery } from "@/hooks/use-api-query";
import { useQueryClient } from "@tanstack/react-query";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import GlassButton from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { ErrorState } from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import { gradientForName, initialsOf } from "@/lib/gradients";
import { cn } from "@/lib/utils";

import { apiJson, RESIDENT_KEYS } from "./_shared/api";
import { friendlyError } from "./_shared/format";
import { GlassField, GlassInput, GlassTextarea } from "./_shared/ui";
import type { ProfileData } from "./_shared/types";
import { ApiClientError } from "@/lib/api";

/* ------------------------------ view helpers ------------------------------- */

/** One glass-inset label/value row inside a grouped profile card. */
function InfoRow({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="glass-inset flex items-center justify-between gap-3 rounded-md px-3.5 py-3">
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("min-w-0 truncate text-right text-sm font-medium", mono && "kpi-num")}>{value}</span>
    </div>
  );
}

type CardTone = "primary" | "success" | "danger";

const CARD_TONES: Record<CardTone, string> = {
  primary: "border-primary/25 bg-primary/15 text-primary",
  success: "border-success/25 bg-success/15 text-success",
  danger: "border-danger/25 bg-danger/15 text-danger",
};

/** Grouped profile card — tinted icon tile + title header (BoardOps InfoCard). */
function InfoCard({
  icon: Icon,
  tone,
  title,
  titleId,
  action,
  children,
}: {
  icon: LucideIcon;
  tone: CardTone;
  title: string;
  titleId: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className="h-full">
      <GlassCard className="h-full space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-md border [&_svg]:size-[18px]",
                CARD_TONES[tone]
              )}
            >
              <Icon aria-hidden />
            </span>
            <h2 id={titleId} className="text-sm font-semibold">
              {title}
            </h2>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {children}
      </GlassCard>
    </section>
  );
}

/* --------------------------------- edit form ------------------------------- */

interface ProfileFormValues {
  fullName: string;
  phone: string;
  roomNumber: string;
  address: string;
  emergencyContact: string;
}

function EditProfileForm({
  profile,
  onCancel,
  onSaved,
}: {
  profile: NonNullable<ProfileData["profile"]>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileFormValues>({
    defaultValues: {
      fullName: profile.fullName ?? "",
      phone: profile.phone ?? "",
      roomNumber: profile.roomNumber ?? "",
      address: profile.address ?? "",
      emergencyContact: profile.emergencyContact ?? "",
    },
  });

  async function onSubmit(values: ProfileFormValues) {
    try {
      await apiJson<ProfileData>("/api/v1/me/profile", "PATCH", {
        fullName: values.fullName.trim(),
        phone: values.phone.trim() || "",
        roomNumber: values.roomNumber.trim() || "",
        address: values.address.trim() || "",
        emergencyContact: values.emergencyContact.trim() || "",
      });
      await queryClient.invalidateQueries({ queryKey: ["api", RESIDENT_KEYS.profile] });
      await queryClient.invalidateQueries({ queryKey: ["api", "/api/v1/auth/me"] });
      toast.success("Profile updated");
      onSaved();
    } catch (err) {
      if (err instanceof ApiClientError && err.fields && Object.keys(err.fields).length > 0) {
        toast.error(Object.values(err.fields)[0] ?? friendlyError(err));
      } else {
        toast.error(friendlyError(err, "We couldn't save your changes. Please try again."));
      }
    }
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="space-y-4"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
    >
      <GlassField label="Full name" error={errors.fullName?.message}>
        <GlassInput
          aria-label="Full name"
          autoComplete="name"
          placeholder="e.g. Sahid Haque"
          {...register("fullName", {
            required: "Enter your full name.",
            validate: (v) => v.trim().length >= 2 || "Enter your full name.",
            maxLength: { value: 90, message: "Keep the name under 90 characters." },
          })}
        />
      </GlassField>

      <GlassField label="Phone" error={errors.phone?.message} hint="Digits, spaces, + and () are fine.">
        <GlassInput
          aria-label="Phone number"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+91 98xxxxxx86"
          {...register("phone", {
            pattern: { value: /^[+0-9 ()-]{6,18}$/, message: "Enter a valid phone number." },
          })}
        />
      </GlassField>

      <GlassField label="Room" error={errors.roomNumber?.message}>
        <GlassInput
          aria-label="Room number"
          placeholder="e.g. B-104"
          {...register("roomNumber", { maxLength: { value: 20, message: "Keep the room under 20 characters." } })}
        />
      </GlassField>

      <GlassField label="Home address" error={errors.address?.message}>
        <GlassTextarea
          aria-label="Home address"
          placeholder="Where family can be reached"
          {...register("address", { maxLength: { value: 200, message: "Keep the address under 200 characters." } })}
        />
      </GlassField>

      <GlassField
        label="Emergency contact"
        error={errors.emergencyContact?.message}
        hint="A person and phone number we can call if needed."
      >
        <GlassInput
          aria-label="Emergency contact"
          placeholder="e.g. Asha Haque · +91 98xxxxxx00"
          {...register("emergencyContact", {
            maxLength: { value: 120, message: "Keep it under 120 characters." },
          })}
        />
      </GlassField>

      <div className="flex items-center justify-end gap-2 pt-1">
        <GlassButton variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </GlassButton>
        <GlassButton type="submit" loading={isSubmitting} icon={<Check />}>
          Save changes
        </GlassButton>
      </div>
    </motion.form>
  );
}

/* --------------------------------- the view -------------------------------- */

export default function ResidentProfile() {
  const { user, institution, logout } = useSession();
  const profileQuery = useApiQuery<ProfileData>("/api/v1/me/profile");
  const [editing, setEditing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const profile = profileQuery.data?.profile ?? null;

  if (profileQuery.isPending) {
    return (
      <div className="space-y-4">
        <div className="glass-skeleton h-52 rounded-xl" />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (profileQuery.isError) {
    return (
      <div className="space-y-4">
        <ErrorState
          code={profileQuery.error?.code}
          message={profileQuery.error?.message}
          onRetry={() => void profileQuery.refetch()}
        />
      </div>
    );
  }

  const displayName = profile?.fullName || user?.email || "You";

  return (
    <StaggerGroup className="space-y-4">
      {/* Profile hero — BoardOps profile-view anatomy: ambient blur blobs,
          gradient avatar, centered name/email + badge row, Edit action */}
      <StaggerItem>
        <GlassCard className="relative overflow-hidden p-6">
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 top-0 size-40 rounded-full bg-primary/30 blur-3xl"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 size-32 rounded-full bg-success/25 blur-3xl"
          />
          <div className="relative z-10 flex flex-col items-center gap-4 text-center">
            <div className="relative">
              <span
                aria-hidden
                className="absolute -inset-2 rounded-full bg-gradient-to-br from-primary/30 to-success/30 blur-md"
              />
              <span
                aria-hidden
                className={cn(
                  "relative flex size-16 items-center justify-center rounded-full bg-gradient-to-br text-xl font-bold text-white ring-2 ring-border/50 sm:size-20 sm:text-2xl",
                  gradientForName(displayName)
                )}
              >
                {initialsOf(displayName)}
              </span>
            </div>
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="min-w-0"
            >
              <h1 className="font-display truncate text-2xl font-bold tracking-tight">{displayName}</h1>
              <p className="mt-0.5 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                <Mail className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{user?.email}</span>
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-pill border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                  <UserRound className="size-3" aria-hidden />
                  Resident
                </span>
                <StatusBadge status={profileQuery.data?.user.status ?? user?.status ?? "ACTIVE"} />
                <span className="inline-flex items-center gap-1 rounded-pill border border-border bg-muted/50 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Building2 className="size-3" aria-hidden />
                  {institution?.name ?? "Aurora Residency Mess"}
                </span>
              </div>
            </motion.div>
            {!editing && (
              <GlassButton variant="secondary" icon={<Pencil />} onClick={() => setEditing(true)}>
                Edit details
              </GlassButton>
            )}
          </div>
        </GlassCard>
      </StaggerItem>

      {/* Grouped cards — BoardOps info-card grid (form goes full width) */}
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Contact — editable personal details */}
        <StaggerItem className={cn(editing && "sm:col-span-2")}>
          <InfoCard icon={Mail} tone="primary" title="Contact" titleId="profile-personal">
            {editing && profile ? (
              <EditProfileForm
                profile={profile}
                onCancel={() => setEditing(false)}
                onSaved={() => setEditing(false)}
              />
            ) : (
              <div className="space-y-2">
                <InfoRow icon={UserRound} label="Full name" value={profile?.fullName || user?.email || "—"} />
                <InfoRow icon={Phone} label="Phone" value={profile?.phone || "Not set"} mono />
                <InfoRow icon={DoorOpen} label="Room" value={profile?.roomNumber || "Not set"} />
                <InfoRow icon={MapPin} label="Home address" value={profile?.address || "Not set"} />
                <InfoRow icon={ShieldCheck} label="Emergency contact" value={profile?.emergencyContact || "Not set"} />
              </div>
            )}
          </InfoCard>
        </StaggerItem>

        {/* Membership — read-only account facts */}
        <StaggerItem>
          <InfoCard icon={ShieldCheck} tone="success" title="Membership" titleId="profile-account">
            <div className="space-y-2">
              <InfoRow icon={Mail} label="Email" value={user?.email} mono />
              <InfoRow
                icon={ShieldCheck}
                label="Status"
                value={<StatusBadge status={profileQuery.data?.user.status ?? user?.status ?? "ACTIVE"} />}
              />
              <InfoRow icon={UserRound} label="Role" value="Resident" />
              <InfoRow icon={Building2} label="Mess" value={institution?.name ?? "Aurora Residency Mess"} />
            </div>
            <p className="mt-1 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              Email and account status are managed by the admin — ask them for changes.
            </p>
          </InfoCard>
        </StaggerItem>

        {/* Session — same GroupCard anatomy: tile header + inset row + action */}
        <StaggerItem className="sm:col-span-2">
          <InfoCard icon={LogOut} tone="danger" title="Session" titleId="profile-session">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="glass-inset min-w-0 flex-1 rounded-md p-3.5">
                <p className="text-sm font-semibold">Signed in on this device</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                  Signing out clears your session here. You can sign back in any time.
                </p>
              </div>
              <GlassButton
                variant="destructive"
                icon={<LogOut />}
                loading={signingOut}
                className="shrink-0"
                onClick={async () => {
                  setSigningOut(true);
                  await logout();
                }}
              >
                Sign out
              </GlassButton>
            </div>
          </InfoCard>
        </StaggerItem>
      </div>

      {editing && (
        <div className="flex justify-start lg:hidden">
          <GlassButton variant="ghost" icon={<X />} onClick={() => setEditing(false)}>
            Close editing
          </GlassButton>
        </div>
      )}
    </StaggerGroup>
  );
}
