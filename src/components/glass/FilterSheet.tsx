"use client";

/**
 * FilterSheet — mobile bottom sheet for list filters (drag-handle pill,
 * 36px sheet radius, glass-strong over the Radix sheet primitives from
 * the shadcn kit — visually reskinned). The shell slides up with a
 * spring-like overshooting curve while the body and footer cascade in
 * with SPRING_SOFT; the scrim fades via the Radix overlay.
 * Desktop (lg+) renders the same controls INLINE inside a glass card
 * (with a CSS rise entrance) instead of a sheet.
 */

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsDesktop } from "@/hooks/use-breakpoint";
import { SPRING_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface FilterSheetProps {
  title: string;
  description?: string;
  /** Controlled open state (used when no trigger is provided). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element (rendered on mobile only). */
  trigger?: ReactNode;
  /** Filter controls. */
  children: ReactNode;
  /** Sticky footer (Apply / Reset row). */
  footer?: ReactNode;
  className?: string;
}

export function FilterSheet({
  title,
  description,
  open,
  onOpenChange,
  trigger,
  children,
  footer,
  className,
}: FilterSheetProps) {
  const isDesktop = useIsDesktop();
  const reduced = useReducedMotion();

  if (isDesktop) {
    return (
      <div className={cn("glass anim-rise w-full rounded-lg p-4", className)}>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h3 className="font-display text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {children}
        {footer && <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent
        side="bottom"
        className={cn(
          "glass-strong rounded-t-[36px] rounded-b-none border-0",
          "inset-x-0 mx-auto max-h-[85vh] max-w-xl px-0 pt-2",
          // spring-like overshoot on the Radix slide-up (y:100% → 0), quick settle on exit
          "data-[state=open]:duration-[520ms] data-[state=open]:ease-[cubic-bezier(0.32,1.26,0.4,1)]",
          "data-[state=closed]:duration-[260ms]",
          className
        )}
      >
        {/* drag handle pill */}
        <div aria-hidden className="mx-auto mt-1.5 h-1.5 w-11 rounded-full bg-foreground/25" />
        <div className="safe-b px-5 pb-5 pt-4">
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { ...SPRING_SOFT, delay: 0.04 }}
          >
            <SheetTitle className="font-display text-left text-base font-semibold">{title}</SheetTitle>
            {description && (
              <p className="mt-1 text-left text-[13px] text-muted-foreground">{description}</p>
            )}
          </motion.div>
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { ...SPRING_SOFT, delay: 0.1 }}
            className="mt-4 max-h-[55vh] overflow-y-auto"
          >
            {children}
          </motion.div>
          {footer && (
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : { ...SPRING_SOFT, delay: 0.16 }}
              className="mt-4 flex items-center justify-end gap-2"
            >
              {footer}
            </motion.div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default FilterSheet;
