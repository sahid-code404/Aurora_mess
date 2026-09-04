"use client";

/**
 * PickerCapsule — BoardOps centered date/month picker (extracted from the
 * Meals pages' house pattern): two circular glass-strong arrows flanking a
 * pill. The pill itself is a button when `onPillClick` is provided (usually
 * "reset to current period" — show the RotateCcw hint via `resettable`).
 *
 * <PickerCapsule
 *   onPrev={…} onNext={…}
 *   prevLabel="Previous month" nextLabel="Next month"
 *   onPillClick={resetToCurrentMonth} resettable={!isThisMonth}
 * >
 *   <Calendar className="size-4 shrink-0 text-primary" aria-hidden />
 *   <span className="min-w-0 text-center leading-tight">
 *     <span className="block truncate text-sm font-bold text-primary">September</span>
 *     <span className="block truncate text-[11px] text-muted-foreground">2025</span>
 *   </span>
 * </PickerCapsule>
 */

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";

export interface PickerCapsuleProps {
  onPrev: () => void;
  onNext: () => void;
  /** Accessible labels for the arrow buttons. */
  prevLabel: string;
  nextLabel: string;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** When provided, the middle pill becomes a button firing this (usually reset). */
  onPillClick?: () => void;
  pillAriaLabel?: string;
  /** Shows the RotateCcw "reset available" hint at the pill's trailing edge. */
  resettable?: boolean;
  /** Pill content (icon + labels). */
  children: ReactNode;
  className?: string;
}

export function CircleArrow({
  direction,
  onClick,
  disabled,
  label,
}: {
  direction: "prev" | "next";
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  const reduced = useReducedMotion();
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <motion.button
      type="button"
      whileTap={reduced ? undefined : { scale: 0.9 }}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="glass-strong flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon className="size-5" aria-hidden />
    </motion.button>
  );
}

export function PickerCapsule({
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
  prevDisabled,
  nextDisabled,
  onPillClick,
  pillAriaLabel,
  resettable,
  children,
  className,
}: PickerCapsuleProps) {
  const pillBody = (
    <>
      {children}
      {resettable && <RotateCcw className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
    </>
  );

  const pillClasses = cn(
    "glass-soft flex min-w-0 max-w-[280px] flex-1 items-center justify-center gap-2.5 rounded-full px-6 py-2.5 transition-all hover:ring-1 hover:ring-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    onPillClick && "cursor-pointer"
  );

  return (
    <div className={cn("flex items-center justify-center gap-4", className)}>
      <CircleArrow direction="prev" label={prevLabel} onClick={onPrev} disabled={prevDisabled} />
      {onPillClick ? (
        <button type="button" onClick={onPillClick} aria-label={pillAriaLabel} className={pillClasses}>
          {pillBody}
        </button>
      ) : (
        <div aria-label={pillAriaLabel} className={pillClasses}>
          {pillBody}
        </div>
      )}
      <CircleArrow direction="next" label={nextLabel} onClick={onNext} disabled={nextDisabled} />
    </div>
  );
}

export default PickerCapsule;
