"use client";

/**
 * Admin Expenses — record mess expenses (server-computed totals), review
 * (approve / reject) and void approved ones with reversals.
 * BoardOps composition, meals-page anatomy: month capsule → KPIs → action
 * bar → ONE Expenses section card (Receipt icon header, filter pills
 * INSIDE) holding compact status-orb rows.
 * GET /api/v1/admin/expenses?status=&q=&month= · POST (multipart) ·
 * POST /:id/approve|reject|void
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Ban,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Package,
  Paperclip,
  Plus,
  ReceiptText,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PickerCapsule } from "@/components/glass/PickerCapsule";
import GlassCard from "@/components/glass/GlassCard";
import StatusBadge from "@/components/glass/StatusBadge";
import Money from "@/components/glass/Money";
import MealOrb from "@/components/glass/MealOrb";
import EmptyState from "@/components/glass/EmptyState";
import ErrorState from "@/components/glass/ErrorState";
import { ListSkeleton } from "@/components/glass/LoadingSkeleton";
import ConfirmDialog from "@/components/glass/ConfirmDialog";
import { GlassButton } from "@/components/glass/GlassButton";
import { StaggerGroup, StaggerItem } from "@/components/glass/Stagger";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useApiQuery, postJson } from "@/hooks/use-api-query";
import { useSession } from "@/hooks/use-session";
import { api, ApiClientError } from "@/lib/api";
import { SPRING_SNAPPY } from "@/lib/motion";
import { useApiMetaQuery, errMessage, useInvalidate, metaNum, metaStr } from "./_shared/api";
import { currentMonthKeyInTz, todayKeyInTz } from "./_shared/business-date";
import { MoneyField, SearchField, SelectField, TextAreaField, TextField, moneyProblem } from "./_shared/fields";
import { Chip, FilterChips, KpiGrid, KeyValue, ProofImage } from "./_shared/chrome";
import { fmtDate, fmtDateTime, fmtMinor, monthLabel, parseMoneyToMinor } from "./_shared/format";
import type { ExpenseCategory, ExpenseRow } from "./_shared/types";

const EXPENSES_PATH = "/api/v1/admin/expenses";
const CATEGORIES_PATH = "/api/v1/admin/expense-categories";

/* ------------------------------------------------------------------ form */

interface DraftItem {
  key: string;
  itemName: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

function draftItem(): DraftItem {
  return { key: crypto.randomUUID(), itemName: "", quantity: "1", unit: "kg", unitPrice: "" };
}

function itemEstimateMinor(item: DraftItem): number | null {
  const price = parseMoneyToMinor(item.unitPrice);
  if (price == null) return null;
  const qty = Number(item.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  // Same rounding as the server: round-half-up on each line.
  return Math.round(qty * price);
}

function ExpenseFormDialog({
  open,
  onOpenChange,
  categories,
  defaultDate,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
  defaultDate: string;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(defaultDate);
  const [categoryId, setCategoryId] = useState("");
  const [description, setDescription] = useState("");
  const [comment, setComment] = useState("");
  const [items, setItems] = useState<DraftItem[]>([draftItem()]);
  const [proof, setProof] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setDate(defaultDate);
  }, [open, defaultDate]);

  const estimate = useMemo(() => {
    let total = 0;
    let ok = true;
    for (const item of items) {
      const line = itemEstimateMinor(item);
      if (line == null) {
        ok = item.itemName.trim() !== "" || item.unitPrice.trim() !== "";
        if (!ok) break;
        continue;
      }
      total += line;
    }
    return ok ? total : null;
  }, [items]);

  const valid =
    description.trim().length >= 2 &&
    items.length > 0 &&
    items.every(
      (i) =>
        i.itemName.trim().length > 0 &&
        Number(i.quantity) > 0 &&
        moneyProblem(i.unitPrice) === null
    );

  function setItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  async function submit() {
    setSaving(true);
    setFields({});
    try {
      const form = new FormData();
      form.set("date", date);
      if (categoryId) form.set("categoryId", categoryId);
      form.set("description", description.trim());
      if (comment.trim()) form.set("comment", comment.trim());
      form.set(
        "itemsJson",
        JSON.stringify(
          items.map((i) => ({
            itemName: i.itemName.trim(),
            quantity: Number(i.quantity),
            unit: i.unit.trim() || undefined,
            unitPrice: i.unitPrice.trim(),
          }))
        )
      );
      if (proof) form.set("proof", proof);

      const created = await api<ExpenseRow>(EXPENSES_PATH, { method: "POST", body: form });
      toast.success("Expense recorded", {
        description: `${created.displayNumber} · ${created.totalFormatted} — waiting for your approval (server-computed total).`,
      });
      onSaved();
      onOpenChange(false);
      // reset for next open
      setDescription("");
      setComment("");
      setItems([draftItem()]);
      setProof(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      if (err instanceof ApiClientError && err.fields) setFields(err.fields);
      toast.error(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Add expense"
      description="Totals are always recomputed by the server from the items — the number below is an estimate."
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </GlassButton>
          <GlassButton loading={saving} disabled={!valid} icon={<Plus />} onClick={() => void submit()}>
            Save expense
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label="Date" type="date" value={date} onChange={setDate} error={fields.date} />
        <SelectField
          label="Category"
          value={categoryId}
          onChange={setCategoryId}
          placeholder="No category"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <TextField
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="e.g. Weekly vegetable market run"
          maxLength={200}
          error={fields.description ?? (description.trim().length > 0 && description.trim().length < 2 ? "Describe the expense in 2–200 characters." : undefined)}
        />

        {/* items repeater */}
        <div>
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Items</p>
          <div className="space-y-2.5">
            <AnimatePresence initial={false}>
              {items.map((item, idx) => (
                <motion.div
                  key={item.key}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="glass-inset space-y-2.5 rounded-md p-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Item {idx + 1}</p>
                    {items.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove item ${idx + 1}`}
                        onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                        className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    )}
                  </div>
                  <TextField label="Name" value={item.itemName} onChange={(v) => setItem(item.key, { itemName: v })} placeholder="e.g. Basmati rice" maxLength={90} />
                  <div className="grid grid-cols-2 gap-2.5">
                    <TextField label="Quantity" value={item.quantity} inputMode="decimal" onChange={(v) => setItem(item.key, { quantity: v })} placeholder="25" />
                    <TextField label="Unit" value={item.unit} onChange={(v) => setItem(item.key, { unit: v })} placeholder="kg" maxLength={20} />
                  </div>
                  <MoneyField label="Unit price" value={item.unitPrice} onChange={(v) => setItem(item.key, { unitPrice: v })} placeholder="90.00" />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          <GlassButton
            variant="secondary"
            size="sm"
            className="mt-2.5"
            icon={<Plus />}
            onClick={() => setItems((prev) => [...prev, draftItem()])}
            disabled={items.length >= 50}
          >
            Add item
          </GlassButton>
          {fields.itemsJson && <p className="mt-1.5 text-[11px] font-medium text-danger">{fields.itemsJson}</p>}
        </div>

        {/* live total — estimate */}
        <div className="glass-inset flex items-center justify-between rounded-md px-3.5 py-3">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Total <span className="font-normal">(estimate)</span>
          </span>
          <span className="kpi-num text-base font-semibold">{estimate != null ? fmtMinor(estimate) : "—"}</span>
        </div>

        {/* proof */}
        <div>
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Proof (optional)</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={(e) => setProof(e.target.files?.[0] ?? null)}
            className="glass-inset h-11 w-full rounded-md px-3 text-sm text-muted-foreground file:mr-3 file:rounded-pill file:border-0 file:bg-primary/12 file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-primary"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">JPEG, PNG or PDF · up to 2 MB.</p>
        </div>

        <TextAreaField label="Comment (optional)" value={comment} onChange={setComment} rows={2} maxLength={500} placeholder="Where it was bought, market notes…" />
      </div>
    </DialogShell>
  );
}

/* ---------------------------------------------------------------- detail */

function ExpenseDetailDialog({
  expense,
  tz,
  onClose,
  onAction,
}: {
  expense: ExpenseRow | null;
  tz: string;
  onClose: () => void;
  onAction: (kind: "approve" | "reject" | "void") => void;
}) {
  return (
    <DialogShell
      open={expense != null}
      onOpenChange={(open) => !open && onClose()}
      title={expense ? `${expense.displayNumber}` : ""}
      description={expense?.description}
      wide
      footer={
        expense ? (
          <>
            {expense.status === "PENDING" && (
              <>
                <GlassButton variant="destructive" icon={<XCircle />} onClick={() => onAction("reject")}>
                  Reject
                </GlassButton>
                <GlassButton variant="primary" icon={<CheckCircle2 />} onClick={() => onAction("approve")}>
                  Approve
                </GlassButton>
              </>
            )}
            {expense.status === "APPROVED" && (
              <GlassButton variant="destructive" icon={<Trash2 />} onClick={() => onAction("void")}>
                Void…
              </GlassButton>
            )}
          </>
        ) : undefined
      }
    >
      {expense && (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proof</p>
            <ProofImage fileId={expense.proofFileId} alt={`Proof for ${expense.displayNumber}`} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</p>
            <KeyValue label="Amount" value={<span className="kpi-num text-base font-semibold">{expense.totalFormatted}</span>} />
            <KeyValue label="Status" value={<StatusBadge status={expense.status} />} />
            <KeyValue label="Source" value={expense.source === "TASK" ? "Task submission" : "Direct entry"} />
            <KeyValue label="Category" value={expense.categoryName ?? "—"} />
            <KeyValue label="Date" value={expense.dateKey ? fmtDate(expense.dateKey) : "—"} />
            <KeyValue label="Created" value={fmtDateTime(expense.createdAt, tz)} />
            {expense.reviewedAt && <KeyValue label="Reviewed" value={fmtDateTime(expense.reviewedAt, tz)} />}
            {expense.comment && <KeyValue label="Comment" value={expense.comment} />}
            <KeyValue label="Items" value={`${expense.itemCount ?? 0} line${expense.itemCount === 1 ? "" : "s"}`} />
            <KeyValue label="Journal" value={expense.journalId ? "Posted" : "—"} />
            {expense.reversalJournalId && <KeyValue label="Reversal" value="Posted" />}
            {expense.voidReason && <KeyValue label="Void reason" value={expense.voidReason} />}
          </div>
          {expense.items && expense.items.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items (server-computed)</p>
              <div className="glass-inset space-y-1 rounded-md p-3">
                {expense.items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 py-1 text-[13px]">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{item.itemName}</span>
                      <span className="kpi-num text-muted-foreground">
                        {" "}
                        · {item.quantity} {item.unit ?? "unit"} × <Money minor={item.unitPriceMinor} plain />
                      </span>
                    </span>
                    <Money minor={item.lineTotalMinor} className="shrink-0 font-semibold" />
                  </div>
                ))}
                <div className="mt-1 flex justify-between border-t border-border/50 pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <Money minor={expense.totalMinor} />
                </div>
              </div>
            </div>
          )}
          {!expense.items && (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Line items stay with the server-computed record; the list shows {expense.itemCount ?? 0} item
              {(expense.itemCount ?? 0) === 1 ? "" : "s"}.
            </p>
          )}
        </div>
      )}
    </DialogShell>
  );
}

/* ------------------------------------------------------------------ view */

/** Status-tinted gradient orb for expense rows (BoardOps row anatomy). */
const EXPENSE_STATUS_ORB: Record<string, { icon: LucideIcon; orb: string }> = {
  PENDING: { icon: Clock, orb: "amber" },
  APPROVED: { icon: CheckCircle2, orb: "emerald" },
  REJECTED: { icon: XCircle, orb: "rose" },
  VOIDED: { icon: Ban, orb: "frost" },
};

function expenseOrb(status: string): { icon: LucideIcon; orb: string } {
  return EXPENSE_STATUS_ORB[status] ?? { icon: ReceiptText, orb: "sky" };
}

/** "2025-09" ± 1 → "2025-08" / "2025-10". */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2025, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Long month name for the picker pill ("September"). */
function monthLongName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y ?? 2025, (m ?? 1) - 1, 1));
}

/** "Sep 2025" for the month-scoped KPI label. */
function monthShortLabel(key: string): string {
  return monthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7)));
}

export default function AdminExpenses() {
  const [status, setStatus] = useState("PENDING");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  // Month scope — undefined = the server's current month (institution tz).
  // Navigating sets an explicit YYYY-MM; the list AND the month KPIs follow it
  // (the route scopes both to the requested month and echoes it in meta.month).
  const [monthParam, setMonthParam] = useState<string | undefined>(undefined);
  const [formOpen, setFormOpen] = useState(false);
  const [detail, setDetail] = useState<ExpenseRow | null>(null);
  const [action, setAction] = useState<"approve" | "reject" | "void" | null>(null);
  const [acting, setActing] = useState(false);
  const invalidate = useInvalidate();
  const { institution } = useSession();
  const tz = institution?.timezone ?? "Asia/Kolkata";

  useEffect(() => {
    const t = window.setTimeout(() => setAppliedSearch(search.trim()), 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data: envelope, isLoading, error, refetch } = useApiMetaQuery<ExpenseRow[]>(EXPENSES_PATH, {
    status: status === "ALL" ? undefined : status,
    q: appliedSearch || undefined,
    month: monthParam,
  });
  const expenses = envelope?.data ?? [];
  const meta = envelope?.meta ?? {};

  const categoriesQuery = useApiQuery<ExpenseCategory[]>(formOpen ? CATEGORIES_PATH : null);
  const categories = categoriesQuery.data ?? [];

  const pendingCount = metaNum(meta, "pendingApproval") ?? expenses.filter((e) => e.status === "PENDING").length;

  const sortedExpenses = useMemo(() => {
    return [...expenses].sort((a, b) => {
      const pA = a.status === "PENDING" ? 0 : 1;
      const pB = b.status === "PENDING" ? 0 : 1;
      if (pA !== pB) return pA - pB;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [expenses]);

  // Effective month — the server echoes the resolved month in meta (it owns
  // the institution timezone); fall back to the client month before load.
  const thisMonthKey = currentMonthKeyInTz(tz);
  const activeMonthKey = metaStr(meta, "month") ?? monthParam ?? thisMonthKey;
  const isThisMonth = activeMonthKey === thisMonthKey;

  async function runAction(kind: "approve" | "reject" | "void", reason?: string) {
    if (!detail) return;
    setActing(true);
    try {
      await postJson(`${EXPENSES_PATH}/${detail.id}/${kind}`, kind === "approve" ? {} : { reason });
      invalidate([EXPENSES_PATH, "/api/v1/admin/funds", "/api/v1/admin/dashboard", "/api/v1/admin/billing"]);
      toast.success(kind === "approve" ? "Expense approved" : kind === "reject" ? "Expense rejected" : "Expense voided", {
        description: `${detail.displayNumber} · ${detail.totalFormatted}`,
      });
      setAction(null);
      setDetail(null);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setActing(false);
    }
  }

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

  return (
    <StaggerGroup className="space-y-4">
      {/* Month capsule — circular arrows + reset pill (BoardOps picker) */}
      <StaggerItem>
      <PickerCapsule
        onPrev={() => setMonthParam(shiftMonthKey(activeMonthKey, -1))}
        onNext={() => setMonthParam(shiftMonthKey(activeMonthKey, 1))}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPillClick={() => setMonthParam(undefined)}
        pillAriaLabel="Reset to the current month"
        resettable={!isThisMonth}
      >
        <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 text-center leading-tight">
          <span className="block truncate text-sm font-bold text-primary">{monthLongName(activeMonthKey)}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{activeMonthKey.slice(0, 4)}</span>
        </span>
      </PickerCapsule>
      </StaggerItem>

      <StaggerItem>
      <KpiGrid
        loading={isLoading && !envelope}
        kpis={[
          {
            label: "Expenses",
            value: metaStr(meta, "expensesThisMonthFormatted") ?? "—",
            icon: <ReceiptText />,
            tone: "primary",
            glow: "primary",
            sub: `${metaNum(meta, "entriesThisMonth") ?? 0} items`,
          },
          {
            label: "Remaining",
            value: metaStr(meta, "remainingFundsFormatted") ?? "—",
            icon: <Package />,
            tone: "success",
            glow: "success",
            sub: "Available",
          },
          {
            label: "Pending",
            value: String(pendingCount),
            icon: <FileText />,
            tone: "warning",
            glow: "warning",
            sub: pendingCount > 0 ? "Needs review" : "All clear",
          },
        ]}
      />
      </StaggerItem>

      <StaggerItem>
      {/* Primary action — Add Expense centered */}
      <div className="flex items-center justify-center">
        <GlassButton variant="primary" icon={<Plus />} onClick={() => setFormOpen(true)}>
          Add Expense
        </GlassButton>
      </div>
      </StaggerItem>

      {/* ONE section card — meals-page anatomy: icon + title, filter pills INSIDE, compact symmetrical pills below. */}
      <StaggerItem>
      <GlassCard className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ReceiptText className="size-5" aria-hidden />
          </span>
          <h3 className="font-semibold text-base">Expenses</h3>
        </div>

        <div className="mb-3 space-y-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search by number, description or category…" />
          <FilterChips
            chips={[
              { value: "PENDING", label: "Pending", count: pendingCount || undefined },
              { value: "ALL", label: "All" },
              { value: "APPROVED", label: "Approved" },
              { value: "REJECTED", label: "Rejected" },
              { value: "VOIDED", label: "Voided" },
            ]}
            value={status}
            onChange={setStatus}
          />
        </div>

        {isLoading && !envelope ? (
          <ListSkeleton rows={5} />
        ) : expenses.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title={appliedSearch ? "No expenses match" : status === "PENDING" ? "No pending expenses" : "No expenses recorded yet"}
            description={
              appliedSearch
                ? "Try searching by a different description, number or category."
                : status === "PENDING"
                  ? "Recorded expenses waiting for your approval will appear here."
                  : "Use Add Expense to record the first mess purchase."
            }
            action={
              !appliedSearch && status !== "PENDING" ? (
                <GlassButton variant="secondary" icon={<Plus />} onClick={() => setFormOpen(true)}>
                  Add Expense
                </GlassButton>
              ) : undefined
            }
          />
        ) : (
          <div className="no-scrollbar max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            <AnimatePresence mode="popLayout">
              {sortedExpenses.map((e, i) => {
                const orb = expenseOrb(e.status);
                const OrbIcon = orb.icon;
                return (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.15 } }}
                    transition={{ ...SPRING_SNAPPY, delay: Math.min(i * 0.04, 0.2) }}
                  >
                    <GlassCard className="overflow-hidden rounded-2xl">
                      <div
                        className="p-3 sm:p-3.5 cursor-pointer transition-colors hover:bg-foreground/4 dark:hover:bg-white/5"
                        onClick={() => setDetail(e)}
                      >
                        {/* Top row: Identity & Time (Left), Amount & Type (Right) — symmetrical balance matching payments */}
                        <div className="flex h-10 items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <MealOrb icon={<OrbIcon />} colorToken={orb.orb} size="sm" />
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-semibold text-foreground tracking-tight" title={e.description}>
                                {e.description}
                              </h4>
                              <p className="kpi-num mt-0.5 text-xs text-muted-foreground flex items-center gap-1 truncate">
                                <Clock className="size-3 shrink-0" aria-hidden />
                                {fmtDateTime(e.createdAt, tz)}
                              </p>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <Money minor={e.totalMinor} className="text-base sm:text-lg font-bold text-foreground block leading-tight" />
                            <span className="kpi-num text-[11px] font-medium text-muted-foreground block mt-0.5">
                              total
                            </span>
                          </div>
                        </div>

                        {/* Bottom row: Badges on left, Details in a pill on right — strictly 1 row for symmetrical heights */}
                        <div className="mt-2.5 flex h-7 items-center justify-between gap-2 border-t border-border/15 pt-2">
                          <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                            <StatusBadge status={e.status} />
                            <Chip tone="frost" className="text-[10px] px-2 py-0.5 shrink-0">
                              {e.categoryName ?? "General"}
                            </Chip>
                            <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                              {e.displayNumber}
                            </span>
                            <span className="kpi-num text-[11px] text-muted-foreground shrink-0">
                              · {e.itemCount ?? 0} item{(e.itemCount ?? 0) === 1 ? "" : "s"}
                            </span>
                            {e.source === "TASK" && (
                              <Chip tone="frost" className="text-[10px] px-2 py-0.5 shrink-0">
                                via task
                              </Chip>
                            )}
                            {e.hasProof && (
                              <span className="inline-flex items-center gap-0.5 text-[11px] text-primary font-medium shrink-0">
                                <Paperclip className="size-3" aria-hidden /> Proof
                              </span>
                            )}
                          </div>

                          {/* Details button in a tactile glass pill matching payments */}
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            onClick={(eEvt) => {
                              eEvt.stopPropagation();
                              setDetail(e);
                            }}
                            aria-label={`Open details for expense ${e.displayNumber}`}
                            className="glass-inset hover:glass-soft flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold text-foreground transition-all hover:text-primary hover:ring-1 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            <span>{e.status === "PENDING" ? "Review" : "Details"}</span>
                            <ChevronRight className="size-3" aria-hidden />
                          </motion.button>
                        </div>
                      </div>
                    </GlassCard>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </GlassCard>
      </StaggerItem>

      <ExpenseFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        categories={categories}
        defaultDate={todayKeyInTz(tz)}
        onSaved={() => invalidate([EXPENSES_PATH, "/api/v1/admin/dashboard"])}
      />

      <ExpenseDetailDialog
        expense={detail}
        tz={tz}
        onClose={() => setDetail(null)}
        onAction={(kind) => setAction(kind)}
      />

      {action && detail && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAction(null)}
          title={
            action === "approve"
              ? "Approve expense"
              : action === "reject"
                ? "Reject expense"
                : "Void expense"
          }
          description={
            action === "approve" ? (
              <>
                The money is posted to the mess ledger (Dr Expenses / Cr Cash) and counts toward this month's formula.
                <span className="mt-2 block font-medium">
                  {detail.displayNumber} · {detail.totalFormatted}
                </span>
              </>
            ) : action === "reject" ? (
              <>
                The record stays for the audit trail but no money moves. The submitter is notified with your reason.
                <span className="mt-2 block font-medium">
                  {detail.displayNumber} · {detail.totalFormatted}
                </span>
              </>
            ) : (
              <>
                A reversal journal is posted — the money returns to cash and the expense stays visible as voided. Approved
                expenses are never deleted.
                <span className="mt-2 block font-medium">
                  {detail.displayNumber} · {detail.totalFormatted}
                </span>
              </>
            )
          }
          confirmLabel={action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Void"}
          tone={action === "approve" ? "primary" : "destructive"}
          requireReason={action !== "approve"}
          loading={acting}
          onConfirm={(reason) => void runAction(action, reason)}
        />
      )}
    </StaggerGroup>
  );
}

/* ------------------------------------------------------------- dialog shell */

function DialogShell({
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
        <div className="flex max-h-[82vh] flex-col">
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
