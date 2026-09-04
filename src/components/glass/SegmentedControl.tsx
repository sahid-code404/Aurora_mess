"use client";

/**
 * SegmentedControl — tab pill switcher with a shared-layout sliding
 * indicator (framer-motion layoutId scoped per instance).
 *
 * Stability enhancements:
 *  - Scoped LayoutGroup: prevents cross-view layout collisions.
 *  - layoutDependency={value}: prevents re-render layout shakes.
 *  - initial={false}: prevents unwanted mount spring animations.
 *  - Full spring droplet physics without interruption.
 */

import { useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface SegmentOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  /** Visual size. Default md (44px row). */
  size?: "sm" | "md";
  className?: string;
  /** Accessible name for the group. */
  "aria-label"?: string;
  layoutId?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
  layoutId: customLayoutId,
}: SegmentedControlProps) {
  const [instanceId] = useState(() => Math.random().toString(36).slice(2, 9));
  const groupId = customLayoutId ?? instanceId;
  const reduced = useReducedMotion();

  return (
    <LayoutGroup id={`segment-group-${groupId}`}>
      <div
        role="radiogroup"
        aria-label={ariaLabel ?? "Segmented control"}
        className={cn(
          "glass-inset flex w-full items-center gap-1 rounded-pill p-1",
          className
        )}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(opt.value)}
              onKeyDown={(e) => {
                const idx = options.findIndex((o) => o.value === value);
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  const next = options[(idx + 1) % options.length];
                  onChange(next.value);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const prev = options[(idx - 1 + options.length) % options.length];
                  onChange(prev.value);
                }
              }}
              className={cn(
                "relative flex-1 rounded-pill text-center font-medium transition-colors select-none cursor-pointer active:scale-95",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-3.5 text-xs font-medium",
                active ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground/80"
              )}
            >
              {active && (
                <motion.span
                  layoutId={`segment-active-${groupId}`}
                  layoutDependency={value}
                  initial={false}
                  className="absolute inset-0 rounded-pill"
                  style={{
                    backgroundColor: "var(--segment-active-bg)",
                    boxShadow: "var(--segment-active-shadow)",
                  }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 450, damping: 32 }
                  }
                />
              )}
              <span className="relative z-10 block truncate">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

export default SegmentedControl;
