"use client";

/**
 * Admin Residents — BoardOps composition, meals-page anatomy: KPIs, then
 * ONE section card (Users icon + title + count + search + filter pills
 * INSIDE) holding compact roster rows — muted glass-inset initials, status
 * badge, balance emphasis, lifecycle overflow menu — each row opens the
 * resident's 360° page.
 * GET /api/v1/admin/residents?q=&status=  (+ lifecycle POST endpoints)
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Eye, MessageSquareWarning, UserCheck, UserMinus, UserRound, Users, XCircle } from "lucide-react";
import { toast } from "sonner";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { navigateTo } from "@/hooks/use-hash-route";
import { postJson } from "@/hooks/use-api-query";
import { ApiClientError } from "@/lib/api";
import { useApiMetaQuery, errMessage, useInvalidate, metaNum } from "./_shared/api";
import { SearchField } from "./_shared/fields";
import { FilterChips, KpiGrid, OverflowMenu, type OverflowAction } from "./_shared/chrome";
import { fmtDate, initialsOf } from "./_shared/format";
import type { ResidentRow } from "./_shared/types";

const RESIDENTS_PATH = "/api/v1/admin/residents";

type LifecycleAction = "approve" | "request-changes" | "reject" | "deactivate" | "activate";

interface PendingAction {
  resident: ResidentRow;
  action: LifecycleAction;
}

const ACTION_META: Record<LifecycleAction, { title: string; description: string; confirm: string; requireReason: boolean; toast: string; destructive?: boolean }> = {
  approve: {
    title: "Approve resident",
    description: "They will be able to sign in, opt into meals and submit payments from their membership start date.",
    confirm: "Approve",
    requireReason: false,
    toast: "Resident approved",
  },
  "request-changes": {
    title: "Request changes",
    description: "The resident will be asked to update their details before you review again.",
    confirm: "Request changes",
    requireReason: true,
    toast: "Changes requested",
  },
  reject: {
    title: "Reject application",
    description: "The application will be closed and the resident will not be able to sign in. This is recorded in the audit trail.",
    confirm: "Reject",
    requireReason: true,
    toast: "Application rejected",
    destructive: true,
  },
  deactivate: {
    title: "Deactivate resident",
    description: "Their sessions are revoked immediately and meals stop being available to them. History is preserved.",
    confirm: "Deactivate",
    requireReason: true,
    toast: "Resident deactivated",
    destructive: true,
  },
  activate: {
    title: "Reactivate resident",
    description: "They will be able to sign in and opt into meals again.",
    confirm: "Reactivate",
    requireReason: false,
    toast: "Resident reactivated",
  },
};

export default function AdminResidents() {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [status, setStatus] = useState("PENDING_APPROVAL");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [acting, setActing] = useState(false);
  const invalidate = useInvalidate();

  useEffect(() => {
    const t = window.setTimeout(() => setAppliedSearch(search.trim()), 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data, isLoading, error, refetch } = useApiMetaQuery<ResidentRow[]>(RESIDENTS_PATH, {
    q: appliedSearch || undefined,
    status: status === "ALL" ? undefined : status,
  });

  const residents = data?.data ?? [];
  const meta = data?.meta ?? {};

  async function runAction(action: LifecycleAction, resident: ResidentRow, reason?: string) {
    setActing(true);
    const info = ACTION_META[action];
    try {
      const needsBody = action !== "approve" && action !== "activate";
      await postJson(`${RESIDENTS_PATH}/${resident.id}/${action}`, needsBody ? { reason } : {});
      invalidate([RESIDENTS_PATH, "/api/v1/admin/dashboard"]);
      toast.success(info.toast, { description: resident.profile.fullName });
      setPending(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

  const lifecycleActions = (resident: ResidentRow): OverflowAction[] => {
    const actions: OverflowAction[] = [];
    if (resident.status === "PENDING_APPROVAL" || resident.status === "CHANGES_REQUESTED") {
      actions.push({ key: "approve", label: "Approve", icon: <CheckCircle2 />, onSelect: () => setPending({ resident, action: "approve" }) });
      actions.push({ key: "request-changes", label: "Request changes", icon: <MessageSquareWarning />, onSelect: () => setPending({ resident, action: "request-changes" }), separatorBefore: true });
      actions.push({ key: "reject", label: "Reject", icon: <XCircle />, onSelect: () => setPending({ resident, action: "reject" }), destructive: true });
    } else if (resident.status === "ACTIVE") {
      actions.push({ key: "deactivate", label: "Deactivate", icon: <UserMinus />, onSelect: () => setPending({ resident, action: "deactivate" }), destructive: true });
    } else if (resident.status === "INACTIVE") {
      actions.push({ key: "activate", label: "Reactivate", icon: <UserCheck />, onSelect: () => setPending({ resident, action: "activate" }) });
    }
    return actions;
  };

  const chips = useMemo(
    () => [
      { value: "PENDING_APPROVAL", label: "Pending", count: metaNum(meta, "pending") ?? undefined },
      { value: "ALL", label: "All", count: metaNum(meta, "total") ?? undefined },
      { value: "ACTIVE", label: "Active", count: metaNum(meta, "active") ?? undefined },
      { value: "INACTIVE", label: "Inactive" },
      { value: "REJECTED", label: "Rejected" },
    ],
    [meta]
  );

  const sortedResidents = useMemo(() => {
    return [...residents].sort((a, b) => {
      const getRank = (st: string) => {
        if (st === "PENDING_APPROVAL") return 0; // Needs admin approval
        if (st === "CHANGES_REQUESTED" || st === "PENDING_DELETION") return 1; // Needs review/attention
        if (st === "ACTIVE") return 2;
        return 3;
      };
      const rA = getRank(a.status);
      const rB = getRank(b.status);
      if (rA !== rB) return rA - rB;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [residents]);

  if (error) {
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

  const pendingInfo = pending ? ACTION_META[pending.action] : null;

  return (
    <StaggerGroup className="space-y-4">
      <StaggerItem>
      <KpiGrid
        loading={isLoading && !data}
        kpis={[
          { label: "Total", value: String(metaNum(meta, "total") ?? residents.length), icon: <Users />, tone: "primary", glow: "primary", sub: "Registered" },
          { label: "Active", value: String(metaNum(meta, "active") ?? "—"), icon: <UserCheck />, tone: "success", glow: "success", sub: "Eligible" },
          { label: "Pending", value: String(metaNum(meta, "pending") ?? "—"), icon: <UserRound />, tone: "warning", glow: "warning", sub: "Needs review" },
        ]}
      />
      </StaggerItem>

      {/* ONE section card — meals-page anatomy: icon + title + count header,
          search + filter pills INSIDE, compact roster rows below. */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Users className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">Residents</h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search by name, email or room…" />
          <FilterChips chips={chips} value={status} onChange={setStatus} layoutId="admin-residents-chips" />
        </div>

        {isLoading && !data ? (
          <ListSkeleton rows={5} />
        ) : residents.length === 0 ? (
          <EmptyState
            icon={Users}
            title={appliedSearch || status !== "ALL" ? "No residents match" : "No residents yet"}
            description={
              appliedSearch || status !== "ALL"
                ? "Try a different search or filter."
                : "Approved residents will appear here with their balance and quick actions."
            }
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {sortedResidents.map((resident, i) => (
              <motion.div
                key={resident.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(i * 0.04, 0.2) }}
              >
                <GlassCard className="overflow-hidden rounded-2xl">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => navigateTo(`#/admin/residents/${resident.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigateTo(`#/admin/residents/${resident.id}`);
                      }
                    }}
                    className="flex min-w-0 cursor-pointer items-center gap-3 p-3 sm:p-3.5 transition-colors hover:bg-foreground/4 dark:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {/* Muted glass-inset initials — the meals roster look. */}
                    <span
                      aria-hidden
                      className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-primary"
                    >
                      {initialsOf(resident.profile.fullName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{resident.profile.fullName}</p>
                        <StatusBadge status={resident.status} />
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {resident.profile.roomNumber ? `Room ${resident.profile.roomNumber} · ` : ""}
                        {resident.email}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                        {resident.funds?.policyState === "RESTRICTED"
                          ? "Meals restricted — deficit"
                          : `Joined ${fmtDate(resident.createdAt)}`}
                      </p>
                    </div>

                    {/* Row actions (360° view & lifecycle menu). */}
                    <div className="flex shrink-0 items-center gap-2">
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.9 }}
                        aria-label={`Open 360° view for ${resident.profile.fullName}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateTo(`#/admin/residents/${resident.id}`);
                        }}
                        className="glass-inset flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-primary transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <Eye className="size-4" aria-hidden />
                      </motion.button>
                      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <OverflowMenu actions={lifecycleActions(resident)} label={`Actions for ${resident.profile.fullName}`} />
                      </span>
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
            ))}
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      {pending && pendingInfo && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={pendingInfo.title}
          description={
            <>
              {pendingInfo.description}
              <span className="mt-2 block font-medium">{pending.resident.profile.fullName}</span>
            </>
          }
          confirmLabel={pendingInfo.confirm}
          tone={pendingInfo.destructive ? "destructive" : "primary"}
          requireReason={pendingInfo.requireReason}
          loading={acting}
          onConfirm={(reason) => void runAction(pending.action, pending.resident, reason)}
        />
      )}
    </StaggerGroup>
  );
}
