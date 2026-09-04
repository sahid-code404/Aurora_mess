"use client";

/**
 * DropletFilterChips — tactile horizontal pill filter strip with a fluid
 * "sliding water droplet" active indicator (framer-motion layoutId).
 *
 * As the user taps between chips, the active pill stretches and slides across
 * with organic surface-tension spring physics, glossy droplet specular
 * highlights, and tactile spring feedback.
 *
 * Stability enhancements:
 *  - LayoutGroup scoping: prevents cross-page layoutId collisions.
 *  - layoutDependency={value}: prevents layout jitter when data/count changes.
 *  - initial={false}: prevents unwanted mount spring animations.
 *  - CSS active:scale-95: avoids nested Framer Motion transform matrices.
 */

import { useEffect, useRef, useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface DropletChip<T extends string = string> {
  value: T;
  label: string;
  count?: number;
}

export interface DropletFilterChipsProps<T extends string = string> {
  chips: DropletChip<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  layoutId?: string;
  "aria-label"?: string;
}

export function DropletFilterChips<T extends string = string>({
  chips,
  value,
  onChange,
  className,
  layoutId: customLayoutId,
  "aria-label": ariaLabel,
}: DropletFilterChipsProps<T>) {
  const [instanceId] = useState(() => Math.random().toString(36).slice(2, 9));
  const groupId = customLayoutId ?? instanceId;
  const reduced = useReducedMotion();

  return (
    <LayoutGroup id={`droplet-group-${groupId}`}>
      <div
        role="tablist"
        aria-label={ariaLabel ?? "Filter options"}
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
                "relative inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap transition-colors select-none active:scale-95",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active
                  ? "text-primary-foreground font-bold"
                  : "glass-inset border border-border/40 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              )}
            >
              {active && (
                <motion.span
                  layoutId={`droplet-active-${groupId}`}
                  layoutDependency={value}
                  initial={false}
                  className="absolute inset-0 rounded-full bg-primary shadow-[inset_0_1.5px_1px_0_rgba(255,255,255,0.42),inset_0_-1px_1px_0_rgba(0,0,0,0.22),0_6px_20px_-6px_color-mix(in_oklab,var(--primary)_75%,transparent)] ring-1 ring-primary/60"
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          type: "spring",
                          stiffness: 440,
                          damping: 30,
                          mass: 0.8,
                        }
                  }
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <span>{chip.label}</span>
                {chip.count != null && chip.count > 0 && (
                  <span
                    className={cn(
                      "kpi-num rounded-pill px-1.5 py-0.2 text-[10px] font-bold leading-none transition-colors",
                      active
                        ? "bg-primary-foreground/25 text-primary-foreground"
                        : "bg-muted text-foreground"
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

export default DropletFilterChips;
