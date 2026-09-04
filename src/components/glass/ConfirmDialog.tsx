"use client";

/**
 * ConfirmDialog — glass dialog for consequential actions.
 * Consequence-explaining copy, optional mandatory reason input,
 * cancel + destructive/primary confirm. Focus trap + ESC via Radix.
 * The Radix shell scale-fades in from 0.94 with a spring-like
 * overshooting curve (and zoom-fades out on close); inside, a tone-tinted
 * icon orb pops with SPRING_POP and the header/footer cascade with
 * SPRING_SOFT. The reason input lives in a child that mounts fresh each
 * time the dialog opens, so its state resets without effects.
 */

import { useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Info, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { GlassButton } from "./GlassButton";
import { SPRING_POP, SPRING_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Plain-language consequence copy: "This payment will be …". */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "destructive";
  /** Ask for (and require) a reason — used for admin overrides etc. */
  requireReason?: boolean;
  reasonPlaceholder?: string;
  onConfirm: (reason: string | undefined) => void | Promise<void>;
  loading?: boolean;
  className?: string;
}

/** Spring-ify the Radix zoom-in-95 → scale 0.94 → 1 with overshoot. */
const SHELL_ENTER_VARS = {
  "--tw-enter-scale": "0.94",
} as CSSProperties;

function ReasonInput({
  placeholder,
  onReasonChange,
  disabled,
  reasonRef,
}: {
  placeholder: string;
  onReasonChange: (reason: string) => void;
  disabled?: boolean;
  reasonRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="mt-4">
      <label htmlFor="confirm-dialog-reason" className="mb-1.5 block text-xs font-medium text-muted-foreground">
        Reason
      </label>
      <input
        id="confirm-dialog-reason"
        ref={reasonRef}
        type="text"
        maxLength={280}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onReasonChange(e.target.value)}
        className="glass-inset h-11 w-full rounded-md px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      />
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  requireReason = false,
  reasonPlaceholder = "Reason (required for the audit trail)",
  onConfirm,
  loading = false,
  className,
}: ConfirmDialogProps) {
  const reasonRef = useRef<HTMLInputElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "glass-strong rounded-xl border-0 p-0 sm:max-w-md",
          // spring-like overshoot on enter, quick fade-zoom on exit
          "data-[state=open]:duration-[440ms] data-[state=open]:ease-[cubic-bezier(0.34,1.38,0.5,1)]",
          "data-[state=closed]:duration-200",
          className
        )}
        style={SHELL_ENTER_VARS}
        onOpenAutoFocus={(e) => {
          if (reasonRef.current) {
            e.preventDefault();
            reasonRef.current.focus();
          }
        }}
      >
        <ReasonFields
          key={open ? "open" : "closed"}
          open={open}
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          tone={tone}
          requireReason={requireReason}
          reasonPlaceholder={reasonPlaceholder}
          onConfirm={onConfirm}
          loading={loading}
          onOpenChange={onOpenChange}
          reasonRef={reasonRef}
        />
      </DialogContent>
    </Dialog>
  );
}

interface ReasonFieldsProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone: "primary" | "destructive";
  requireReason: boolean;
  reasonPlaceholder: string;
  onConfirm: (reason: string | undefined) => void | Promise<void>;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  reasonRef: RefObject<HTMLInputElement | null>;
}

function ReasonFields({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone,
  requireReason,
  reasonPlaceholder,
  onConfirm,
  loading,
  onOpenChange,
  reasonRef,
}: ReasonFieldsProps) {
  const [reason, setReason] = useState("");
  const reduced = useReducedMotion();
  const reasonValid = !requireReason || reason.trim().length >= 3;

  if (!open) return null;

  const destructive = tone === "destructive";
  const OrbIcon = destructive ? TriangleAlert : Info;

  return (
    <div className="p-5 sm:p-6">
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : { ...SPRING_SOFT, delay: 0.04 }}
      >
        <motion.span
          initial={reduced ? false : { scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={reduced ? { duration: 0 } : SPRING_POP}
          className={cn(
            "mb-4 flex size-13 shrink-0 items-center justify-center rounded-xl border [&_svg]:size-6",
            destructive
              ? "border-danger/30 bg-gradient-to-br from-danger/22 to-danger/6 text-danger shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-10px_color-mix(in_oklab,var(--danger)_55%,transparent)]"
              : "border-primary/25 bg-gradient-to-br from-primary/22 to-primary/6 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-10px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
          )}
        >
          <OrbIcon aria-hidden />
        </motion.span>
        <DialogTitle className="font-display text-left text-lg font-semibold tracking-tight">
          {title}
        </DialogTitle>
        {description && (
          <DialogDescription className="mt-2 text-left text-sm leading-relaxed text-muted-foreground">
            {description}
          </DialogDescription>
        )}
        {requireReason && (
          <ReasonInput
            placeholder={reasonPlaceholder}
            onReasonChange={setReason}
            disabled={loading}
            reasonRef={reasonRef}
          />
        )}
      </motion.div>
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : { ...SPRING_SOFT, delay: 0.12 }}
      >
        <DialogFooter className="mt-6 gap-2 sm:gap-2">
          <GlassButton variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </GlassButton>
          <GlassButton
            variant={destructive ? "destructive" : "primary"}
            loading={loading}
            disabled={!reasonValid}
            onClick={() => void onConfirm(requireReason ? reason.trim() : undefined)}
          >
            {confirmLabel}
          </GlassButton>
        </DialogFooter>
      </motion.div>
    </div>
  );
}

export default ConfirmDialog;
