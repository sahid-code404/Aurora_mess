"use client";

/**
 * Shared admin-view chrome: KPI grid, filter chips, glass-skinned overflow
 * menu, dialog shell, key/value rows, proof preview, animated list helpers.
 */

import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, FileText, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { KpiCard, type KpiGlow, type KpiTone } from "@/components/glass/KpiCard";
import { GlassButton, type GlassButtonVariant } from "@/components/glass/GlassButton";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ KPIs */

export interface KpiSpec {
  label: string;
  value: string;
  sub?: ReactNode;
  icon?: ReactNode;
  /** Icon-orb tint (BoardOps colored-orb pattern). */
  tone?: KpiTone;
  /** Ambient glow tone. */
  glow?: KpiGlow;
  onClick?: () => void;
  navLabel?: string;
}

/** Consistent responsive KPI row:
 * 3 KPIs: matches meals page behavior (grid grid-cols-3 gap-3).
 * 4 KPIs: matches dashboard behavior (grid-kpi gap-3).
 */
export function KpiGrid({ kpis, loading, className }: { kpis: KpiSpec[]; loading?: boolean; className?: string }) {
  const isThree = kpis.length === 3;
  const defaultGrid = isThree ? "grid grid-cols-3 gap-3" : "grid-kpi gap-3";
  return (
    <div className={cn(defaultGrid, className)}>
      {kpis.map((k, i) => (
        <KpiCard
          key={k.label}
          label={k.label}
          value={k.value}
          sub={k.sub}
          icon={k.icon}
          tone={k.tone}
          glow={k.glow}
          onClick={k.onClick}
          navLabel={k.navLabel}
          index={i}
          loading={loading}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- filter chips */

export interface FilterChip {
  value: string;
  label: string;
  count?: number;
}

export function FilterChips({
  chips,
  value,
  onChange,
  className,
  layoutId: customLayoutId,
}: {
  chips: FilterChip[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  layoutId?: string;
}) {
  const [instanceId] = useState(() => Math.random().toString(36).slice(2, 9));
  const activeLayoutId = customLayoutId ?? instanceId;
  const reduced = useReducedMotion();

  return (
    <LayoutGroup id={`filter-chips-${activeLayoutId}`}>
      <div
        role="tablist"
        aria-label="Filter"
        className={cn("no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5", className)}
      >
        {chips.map((chip) => {
          const active = chip.value === value;
          return (
            <button
              key={chip.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(chip.value)}
              className={cn(
                "relative flex h-8.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-pill px-3 text-xs font-medium whitespace-nowrap transition-colors active:scale-95",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active
                  ? "text-primary-foreground font-semibold"
                  : "glass-soft text-muted-foreground hover:text-foreground"
              )}
            >
              {active && (
                <motion.span
                  layoutId={`filter-chip-active-${activeLayoutId}`}
                  layoutDependency={value}
                  initial={false}
                  className="absolute inset-0 rounded-pill bg-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_6px_20px_-8px_color-mix(in_oklab,var(--primary)_70%,transparent)]"
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 440, damping: 32 }
                  }
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <span>{chip.label}</span>
                {chip.count !== undefined && (
                  <span
                    className={cn(
                      "kpi-num rounded-pill px-1.5 py-0.5 text-[11px] font-semibold",
                      active
                        ? "bg-primary-foreground/25 text-primary-foreground"
                        : "bg-foreground/8 text-muted-foreground dark:bg-white/10"
                    )}
                  >
                    {chip.count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

/* --------------------------------------------------------- overflow menu */

export interface OverflowAction {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/** Glass-skinned [•••] overflow menu (shadcn DropdownMenu under the hood). */
export function OverflowMenu({ actions, label = "More actions" }: { actions: OverflowAction[]; label?: string }) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="glass-inset flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:text-foreground [&_svg]:size-4"
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="glass-strong min-w-[12rem] rounded-xl border-0 p-1.5"
      >
        {actions.map((action) => (
          <div key={action.key}>
            {action.separatorBefore && <DropdownMenuSeparator className="my-1 bg-border/60" />}
            <DropdownMenuItem
              disabled={action.disabled}
              onSelect={() => action.onSelect()}
              className={cn(
                "h-10 cursor-pointer rounded-md text-sm font-medium focus:bg-foreground/8 dark:focus:bg-white/10 [&_svg]:size-4 [&_svg]:shrink-0",
                action.destructive ? "text-danger focus:bg-danger/10 focus:text-danger" : "text-foreground"
              )}
            >
              {action.icon}
              <span className="ml-2.5">{action.label}</span>
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------ dialog shell */

export function DetailDialog({
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
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "glass-strong rounded-2xl border-0 p-0 overflow-hidden w-[calc(100%-1.5rem)] sm:w-full",
          wide ? "sm:max-w-2xl" : "sm:max-w-md"
        )}
      >
        <div className="flex max-h-[85vh] flex-col w-full min-w-0">
          <div className="px-4 pt-4 sm:px-6 sm:pt-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">{title}</DialogTitle>
            {description && (
              <DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </DialogDescription>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6 sm:py-4">{children}</div>
          {footer && (
            <div className="safe-b flex flex-wrap items-center justify-end gap-2 border-t border-border/50 px-4 py-3 sm:px-6 sm:py-4">
              {footer}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------- key / value */

export function KeyValue({
  label,
  value,
  stacked,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  stacked?: boolean;
  className?: string;
}) {
  if (stacked) {
    return (
      <div className={cn("min-w-0", className)}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-sm font-medium">{value}</p>
      </div>
    );
  }
  return (
    <div className={cn("flex items-baseline justify-between gap-3 sm:gap-4 py-1 sm:py-1.5", className)}>
      <span className="shrink-0 text-xs sm:text-[13px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-xs sm:text-sm font-medium">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ chips */

export function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "frost";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-muted/70 text-muted-foreground border-border",
    success: "bg-success/12 text-success border-success/30",
    warning: "bg-warning/14 text-warning border-warning/35",
    danger: "bg-danger/12 text-danger border-danger/30",
    frost: "bg-primary/10 text-primary border-primary/28",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill border px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold whitespace-nowrap",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------- proof preview */

export function ProofImage({
  fileId,
  alt,
  className,
}: {
  fileId: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!fileId || failed) {
    return (
      <div
        className={cn(
          "glass-inset flex h-32 w-full items-center justify-center rounded-md text-muted-foreground [&_svg]:size-8",
          className
        )}
      >
        <FileText aria-hidden />
      </div>
    );
  }
  return (
    <div className={cn("glass-inset overflow-hidden rounded-md p-1.5", className)}>
      { }
      <img
        src={`/api/v1/files/${fileId}`}
        alt={alt}
        className="h-32 w-full rounded-[6px] object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/* -------------------------------------------------------- animated lists */

export const listVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.035 } },
  exit: { opacity: 0, transition: { staggerChildren: 0.02, staggerDirection: -1 as const } },
};

export const listItemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" as const } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.14 } },
};

/** List container with subtle staggered entrance; items opt-in via variants. */
export function MotionList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={listVariants} initial="hidden" animate="show" className={className}>
      {children}
    </motion.div>
  );
}

export function MotionItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={listItemVariants} className={className}>
      {children}
    </motion.div>
  );
}

/** AnimatePresence wrapper that removes exited children smoothly. */
export function AnimatedListShell({ items, children }: { items: string; children: ReactNode }) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <div key={items}>{children}</div>
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------ misc buttons */

export function ViewButton({ onClick, label = "View" }: { onClick: () => void; label?: string }) {
  return (
    <GlassButton variant="secondary" size="sm" onClick={onClick}>
      {label}
    </GlassButton>
  );
}

export function LoadMoreButton({ onClick, loading, hasMore }: { onClick: () => void; loading: boolean; hasMore: boolean }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center pt-1">
      <GlassButton variant="secondary" onClick={onClick} loading={loading}>
        Load more
      </GlassButton>
    </div>
  );
}

/* ------------------------------------------------------- collapse section */

export function CollapseRow({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass-inset rounded-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-11 w-full items-center justify-between px-3.5 text-left text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {label}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------- helpers */

/** Small inline "saved" tick used after successful inline edits. */
export function SavedTick() {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-success/12 px-2 py-0.5 text-[11px] font-semibold text-success">
      <Check className="size-3" aria-hidden />
      Saved
    </span>
  );
}

/** Reason-required confirm dialog state machine helper. */
export function usePendingAction<T>() {
  const [pending, setPending] = useState<T | null>(null);
  const clear = () => setPending(null);
  return { pending, setPending, clear };
}

/** Button used inside dialogs (consistent sizing). */
export function DialogButton({
  variant = "secondary",
  onClick,
  loading,
  disabled,
  children,
}: {
  variant?: GlassButtonVariant;
  onClick?: () => void;
  loading?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <GlassButton variant={variant} onClick={onClick} loading={loading} disabled={disabled}>
      {children}
    </GlassButton>
  );
}

/** A quiet mono code chip (request ids, codes). */
export function MonoChip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  void ref;
  return (
    <code className="glass-inset rounded-pill px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </code>
  );
}
