"use client";

/**
 * Admin Audit Trail — filterable, expandable before/after summaries,
 * cursor pagination ("Load more").
 * BoardOps composition, meals-page anatomy: KPIs → ONE Audit-trail section
 * card (ScrollText icon header, search + entity pills INSIDE) holding
 * compact severity-orb rows.
 * GET /api/v1/admin/audit?action=&entityType=&cursor=
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Calendar, CheckCircle2, ChevronDown, Circle, Layers, ListChecks, ScrollText, TriangleAlert, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GlassButton } from "@/components/glass/GlassButton";
import GlassCard from "@/components/glass/GlassCard";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { useSession } from "@/hooks/use-session";
import { useApiMetaQuery } from "./_shared/api";
import { currentMonthKeyInTz } from "./_shared/business-date";
import { SearchField } from "./_shared/fields";
import { Chip, FilterChips, KpiGrid } from "./_shared/chrome";
import { fmtDateTime } from "./_shared/format";
import type { AuditRow } from "./_shared/types";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";

const AUDIT_PATH = "/api/v1/admin/audit";

function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2026, (m ?? 1) - 1, 1));
}

const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: "PAYMENT", label: "Payments" },
  { value: "EXPENSE", label: "Expenses" },
  { value: "BILL", label: "Bills" },
  { value: "BILLING_PERIOD", label: "Billing periods" },
  { value: "RESIDENT", label: "Residents" },
  { value: "MEAL_DEFINITION", label: "Meal definitions" },
  { value: "TASK", label: "Tasks" },
  { value: "TASK_SUBMISSION", label: "Task submissions" },
  { value: "CALENDAR_EVENT", label: "Calendar events" },
  { value: "ANNOUNCEMENT", label: "Announcements" },
  { value: "SETTINGS", label: "Settings" },
  { value: "FORMULA_VERSION", label: "Formula versions" },
  { value: "POLICY", label: "Policies" },
  { value: "NOTIFICATION", label: "Notifications" },
];

/* Severity derived from the action verb (presentational only). */
type Severity = "success" | "warning" | "danger" | "neutral";

function severityOf(action: string): Severity {
  const a = action.toUpperCase();
  if (/(REJECT|VOID|DEACTIVAT|DELET|CANCEL|RESTRICT)/.test(a)) return "danger";
  if (/(APPROV|ACTIVAT|CREAT|REGISTER|PUBLISH|ISSUE|ACCEPT|COMPLET)/.test(a)) return "success";
  if (/(OVERRID|ADJUST|CHANGE|REQUEST|EDIT|UPDAT|START|SUBMIT|ARCHIV|TOGGL)/.test(a)) return "warning";
  return "neutral";
}

const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: TriangleAlert,
  neutral: Circle,
};

const SEVERITY_ORB: Record<Severity, string> = {
  success: "emerald",
  danger: "rose",
  warning: "amber",
  neutral: "frost",
};

function prettyJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function AdminAudit() {
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";
  const currentMonthKey = currentMonthKeyInTz(tz);
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const monthKey = monthParam ?? currentMonthKey;
  const [actionText, setActionText] = useState("");
  const [entityType, setEntityType] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<AuditRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [seenPageKey, setSeenPageKey] = useState<string | null>(null);

  const paramsKey = JSON.stringify({ action: appliedAction, entityType, month: monthKey });

  // Filter changes reset pagination (set-state-during-render reset pattern, ref-free).
  const [prevKey, setPrevKey] = useState(paramsKey);
  if (prevKey !== paramsKey) {
    setPrevKey(paramsKey);
    setItems([]);
    setCursor(undefined);
    setSeenPageKey(null);
  }

  // Debounce the free-text action filter.
  useEffect(() => {
    const t = window.setTimeout(() => setAppliedAction(actionText.trim()), 500);
    return () => window.clearTimeout(t);
  }, [actionText]);

  const { data: page, isLoading, error, refetch } = useApiMetaQuery<AuditRow[]>(AUDIT_PATH, {
    action: appliedAction || undefined,
    entityType: entityType || undefined,
    month: monthKey,
    cursor,
  });

  // Accumulate pages: incorporate each cursor-keyed page exactly once (refetch-safe).
  const pageKey = page ? `${paramsKey}:${cursor ?? "__first__"}` : null;
  if (page && pageKey !== null && pageKey !== seenPageKey) {
    setSeenPageKey(pageKey);
    const rows = page.data;
    setItems((prev) => (cursor ? [...prev, ...rows] : rows));
  }

  const nextCursor =
    typeof page?.meta?.nextCursor === "string" && page.meta.nextCursor !== "" ? page.meta.nextCursor : null;

  // KPIs are derived client-side from the accumulated entries.
  const stats = useMemo(
    () => ({
      entries: items.length,
      entities: new Set(items.map((r) => r.entityType ?? "—")).size,
      actions: new Set(items.map((r) => r.action)).size,
    }),
    [items]
  );

  const entityChips = useMemo(() => [{ value: "", label: "All entities" }, ...ENTITY_TYPES], []);

  if (error && items.length === 0) {
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
      {/* Month capsule — circular arrows + reset pill (BoardOps picker) */}
      <StaggerItem>
      <PickerCapsule
        onPrev={() => setMonthParam(shiftMonthKey(monthKey, -1))}
        onNext={() => setMonthParam(shiftMonthKey(monthKey, 1))}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPillClick={() => setMonthParam(undefined)}
        pillAriaLabel="Reset to the current month"
        resettable={monthKey !== currentMonthKey}
      >
        <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 text-center leading-tight">
          <span className="block truncate text-sm font-bold text-primary">{monthLongName(monthKey)}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{monthKey.slice(0, 4)}</span>
        </span>
      </PickerCapsule>
      </StaggerItem>
      <StaggerItem>
      <KpiGrid
        loading={isLoading && items.length === 0}
        kpis={[
          { label: "Entries", value: String(stats.entries), icon: <ScrollText />, tone: "primary", glow: "primary", sub: "Events" },
          { label: "Entities", value: String(stats.entities), icon: <Layers />, tone: "success", glow: "success", sub: "Types" },
          { label: "Actions", value: String(stats.actions), icon: <ListChecks />, tone: "warning", glow: "warning", sub: "Verbs" },
        ]}
      />
      </StaggerItem>

      {/* ONE section card — meals-page anatomy: icon + title + count header,
          search + entity pills INSIDE, compact severity-orb rows below. */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ScrollText className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold">Audit trail</h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField
            value={actionText}
            onChange={setActionText}
            placeholder="Search action (e.g. PAYMENT_APPROVED)…"
          />
          <FilterChips chips={entityChips} value={entityType} onChange={setEntityType} />
        </div>

        {isLoading && items.length === 0 ? (
          <ListSkeleton rows={6} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={appliedAction || entityType ? "No audit entries match" : `No audit entries in ${monthLongName(monthKey)}`}
            description={appliedAction || entityType ? "Try clearing the filters — actions appear here as admins approve, void, override and publish." : "Actions performed in this month will appear here automatically."}
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
          {items.map((row, i) => {
            const expanded = expandedId === row.id;
            const before = prettyJson(row.beforeSummary);
            const after = prettyJson(row.afterSummary);
            const severity = severityOf(row.action);
            const SeverityIcon = SEVERITY_ICON[severity];
            return (
              <motion.div
                key={row.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(i * 0.04, 0.2) }}
              >
                <GlassCard className="overflow-hidden">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-foreground/4 dark:hover:bg-white/5",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    )}
                  >
                    {/* action orb, tinted by severity */}
                    <MealOrb icon={<SeverityIcon />} colorToken={SEVERITY_ORB[severity]} size="sm" />

                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Chip tone={severity}>{row.action}</Chip>
                        <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                          on <span className="font-medium text-foreground">{row.entityType ?? "—"}</span>
                          {row.entityId ? (
                            <span className="font-mono text-[10px] text-muted-foreground/70"> · {row.entityId.slice(0, 10)}…</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="kpi-num text-[11px] text-muted-foreground">{fmtDateTime(row.occurredAt)}</span>
                        <Chip tone={row.actorRole === "ADMIN" ? "frost" : "neutral"}>{row.actorRole ?? "—"}</Chip>
                        {row.reason && (
                          <span className="min-w-0 flex-1 basis-24 truncate text-[11px] italic text-muted-foreground/80">
                            “{row.reason}”
                          </span>
                        )}
                      </span>
                    </span>

                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {(before || after) && <Chip tone="neutral">Δ</Chip>}
                      <motion.span
                        animate={{ rotate: expanded ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex text-muted-foreground"
                      >
                        <ChevronDown className="size-4" aria-hidden />
                      </motion.span>
                    </span>
                  </button>

                  <AnimatePresence initial={false}>
                    {expanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-3 border-t border-border/50 p-3">
                          {(before || after) ? (
                            <div className="grid gap-3 min-[420px]:grid-cols-2">
                              {before && (
                                <div className="glass-inset min-w-0 rounded-md p-3">
                                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Before
                                  </p>
                                  <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground/85">
                                    {before}
                                  </pre>
                                </div>
                              )}
                              {after && (
                                <div className="glass-inset min-w-0 rounded-md p-3">
                                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    After
                                  </p>
                                  <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground/85">
                                    {after}
                                  </pre>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-[13px] text-muted-foreground">No before/after details were recorded.</p>
                          )}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
                            <span className="kpi-num font-mono">req {row.requestId ?? "—"}</span>
                            {row.ip && <span className="font-mono">ip {row.ip}</span>}
                            {row.userAgent && <span className="min-w-0 max-w-full truncate">{row.userAgent}</span>}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </GlassCard>
              </motion.div>
            );
          })}
          </div>
        )}

        {nextCursor && (
          <div className="flex justify-center pt-3">
            <GlassButton variant="secondary" onClick={() => setCursor(nextCursor)} loading={isLoading}>
              Load more
            </GlassButton>
          </div>
        )}
      </GlassCard>
      </StaggerItem>
    </StaggerGroup>
  );
}
