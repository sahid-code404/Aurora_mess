"use client";

/**
 * Shared glass form/dialog primitives for the resident views (Task 5-b).
 * - SheetDialog: bottom-sheet on mobile (32px top radius + drag indicator),
 *   centered glass dialog on desktop — matches FilterSheet/ConfirmDialog.
 * - GlassField / GlassSelect: labelled inputs on the inset glass material.
 * - AmountInput: ₹ prefix, 2-decimal validation (money stays a string until
 *   parseAmountToMinor runs — the server re-parses and is authoritative).
 * - FileProofInput: JPEG/PNG/PDF ≤2MB picker with name + size feedback.
 * - Stepper: quantity stepper with 44px targets.
 * - MealGlyph / NoticeGlyph: icon-from-name renderers (createElement keeps
 *   the React-compiler lint happy about dynamic icon components).
 */

import { createElement, useId, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Minus, Plus, Paperclip, Search, X, Bell } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsDesktop } from "@/hooks/use-breakpoint";
import { GlassButton } from "@/components/glass/GlassButton";
import { cn } from "@/lib/utils";
import { mealIcon, notificationIcon } from "./format";

/* ------------------------------- SearchInput ------------------------------- */

/** BoardOps-style search field (icon + inset glass material, 44px target). */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const inputId = useId();
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <label htmlFor={id ?? inputId} className="sr-only">
        {placeholder}
      </label>
      <input
        id={id ?? inputId}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(INPUT_CLASS, "pl-9")}
      />
    </div>
  );
}

/* ------------------------------- SheetDialog ------------------------------- */

/** Render a meal icon by its API name (see mealIcon in ./format). */
export function MealGlyph({ icon, className }: { icon?: string | null; className?: string }) {
  return createElement(mealIcon(icon), { className, "aria-hidden": true });
}

/** Render a notification/activity icon by its API type. */
export function NoticeGlyph({ type, className }: { type: string; className?: string }) {
  return createElement(notificationIcon(type), { className, "aria-hidden": true });
}

export interface SheetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Sticky footer (primary + cancel actions). */
  footer?: ReactNode;
  contentClassName?: string;
}

export function SheetDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  contentClassName,
}: SheetDialogProps) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton
          className="glass-strong rounded-2xl border-0 p-0 sm:max-w-md"
        >
          <div className="p-5 sm:p-6">
            <DialogTitle className="text-left text-lg font-semibold tracking-tight">{title}</DialogTitle>
            {description && (
              <DialogDescription className="mt-1.5 text-left text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </DialogDescription>
            )}
            <div className={cn("mt-4 max-h-[60vh] overflow-y-auto pr-1", contentClassName)}>{children}</div>
            {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="glass-strong rounded-t-[32px] rounded-b-none border-0 inset-x-0 mx-auto max-h-[92vh] max-w-xl px-0 pt-2 data-[state=open]:slide-in-from-bottom"
      >
        <div aria-hidden className="mx-auto mt-1.5 h-1.5 w-10 rounded-full bg-foreground/20" />
        <div className="safe-b px-5 pb-5 pt-4">
          <SheetTitle className="text-left text-base font-semibold">{title}</SheetTitle>
          {description && (
            <p className="mt-1 text-left text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          )}
          <div className={cn("mt-4 max-h-[68vh] overflow-y-auto", contentClassName)}>{children}</div>
          {footer && <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* -------------------------------- GlassField ------------------------------- */

const INPUT_CLASS =
  "glass-inset h-11 w-full rounded-md px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-60";

export function GlassField({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function GlassInput(props: React.ComponentProps<"input">) {
  return <input {...props} className={cn(INPUT_CLASS, props.className)} />;
}

export function GlassTextarea(props: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={cn(INPUT_CLASS, "h-auto min-h-[88px] py-2.5 leading-relaxed", props.className)}
    />
  );
}

export function GlassSelect(props: React.ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cn(INPUT_CLASS, "cursor-pointer appearance-none bg-transparent", props.className)}
    />
  );
}

/* -------------------------------- AmountInput ------------------------------ */

export function AmountInput({
  value,
  onChange,
  invalid,
  ariaLabel,
  placeholder = "0.00",
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
  ariaLabel: string;
  placeholder?: string;
  id?: string;
}) {
  return (
    <div className="glass-inset flex h-11 items-center rounded-md">
      <span aria-hidden className="kpi-num select-none pl-3 text-sm font-semibold text-muted-foreground">
        ₹
      </span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
          onChange(v.slice(0, 12));
        }}
        className="kpi-num h-full w-full bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}

/* ------------------------------- Stepper ----------------------------------- */

export function Stepper({
  value,
  onChange,
  min = 1,
  max = 10,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  label: string;
}) {
  return (
    <div className="glass-inset flex h-11 items-center justify-between rounded-md">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="flex size-11 items-center justify-center rounded-md text-foreground font-bold transition-colors hover:bg-foreground/10 hover:text-primary disabled:opacity-30 dark:hover:bg-white/10 cursor-pointer"
      >
        <Minus className="size-4 stroke-[2.75]" aria-hidden />
      </button>
      <motion.span
        key={value}
        initial={{ scale: 0.85, opacity: 0.6 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 28 }}
        className="kpi-num min-w-8 text-center text-base font-bold text-foreground"
        aria-live="polite"
        aria-label={`${label}: ${value}`}
      >
        {value}
      </motion.span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="flex size-11 items-center justify-center rounded-md text-foreground font-bold transition-colors hover:bg-foreground/10 hover:text-primary disabled:opacity-30 dark:hover:bg-white/10 cursor-pointer"
      >
        <Plus className="size-4 stroke-[2.75]" aria-hidden />
      </button>
    </div>
  );
}

/* ------------------------------ FileProofInput ----------------------------- */

export const PROOF_ACCEPT = "image/jpeg,image/png,application/pdf";
const MAX_PROOF_BYTES = 2 * 1024 * 1024;

export function proofProblems(file: File): string | null {
  const okTypes = ["image/jpeg", "image/png", "application/pdf"];
  if (!okTypes.includes(file.type)) return "Only photos (JPEG/PNG) or PDF files are supported.";
  if (file.size > MAX_PROOF_BYTES) return "This file is larger than 2 MB. Please pick a smaller one.";
  return null;
}

export function FileProofInput({
  file,
  onFile,
  onClear,
  error,
  id,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  onClear?: () => void;
  error?: string | null;
  id?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  if (file) {
    return (
      <div className="glass-inset flex items-center gap-3 rounded-md p-3">
        <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="kpi-num text-xs text-muted-foreground">
            {(file.size / 1024).toFixed(0)} KB · {file.type.split("/").pop()?.toUpperCase()}
          </p>
        </div>
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={() => {
            onFile(null);
            onClear?.();
            if (inputRef.current) inputRef.current.value = "";
          }}
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 dark:hover:bg-white/5"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="glass-inset flex h-11 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Paperclip className="size-4" aria-hidden />
        Attach proof (optional)
      </button>
      <input
        ref={inputRef}
        id={id ?? inputId}
        type="file"
        accept={PROOF_ACCEPT}
        className="sr-only"
        aria-label="Attach proof file"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          onFile(f);
        }}
      />
      {error && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------ helper buttons ----------------------------- */

export function SheetFooterActions({
  onCancel,
  cancelLabel = "Cancel",
  children,
}: {
  onCancel: () => void;
  cancelLabel?: string;
  children: ReactNode;
}) {
  return (
    <>
      <GlassButton variant="ghost" onClick={onCancel}>
        {cancelLabel}
      </GlassButton>
      {children}
    </>
  );
}

/* ------------------------------- notice line ------------------------------- */

export function FormNotice({
  tone = "warning",
  children,
}: {
  tone?: "warning" | "danger" | "info";
  children: ReactNode;
}) {
  return (
    <motion.p
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      role="alert"
      className={cn(
        "glass-inset rounded-md px-3 py-2 text-xs font-medium leading-relaxed",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-danger",
        tone === "info" && "text-muted-foreground"
      )}
    >
      {children}
    </motion.p>
  );
}

/** Small label/value row used in bill + estimate breakdowns. */
export function DataRow({
  label,
  value,
  strong,
  emphasized,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-1.5",
        strong && "border-t border-border pt-2.5"
      )}
    >
      <span
        className={cn(
          "text-[13px] text-muted-foreground",
          strong && "text-sm font-semibold text-foreground"
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "kpi-num text-[13px] font-medium",
          strong && "text-base font-semibold",
          emphasized && "text-base font-semibold text-primary"
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Loading block used inside sheets while a preview loads. */
export function InlinePreviewSkeleton() {
  return (
    <div className="glass-inset space-y-2 rounded-md p-3" aria-label="Loading preview">
      <div className="glass-skeleton h-3 w-2/3" />
      <div className="glass-skeleton h-3 w-1/2" />
    </div>
  );
}
