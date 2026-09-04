"use client";

/**
 * TabRow — horizontally scrollable tab strip (360° view, filter tabs).
 * Sliding shared-layout active pill (primary tint + inset highlight,
 * SPRING_SNAPPY), active text in primary, spring tap feedback, hidden
 * scrollbars with soft edge fades (`no-scrollbar fade-x`), 44px targets.
 *
 * Stability enhancements:
 *  - Scoped LayoutGroup: prevents cross-view layout collisions.
 *  - layoutDependency={activeKey}: prevents re-render layout shakes.
 *  - initial={false}: prevents unwanted mount spring animations.
 *  - Native button active:scale-95: avoids nested transform matrices.
 */

import { useEffect, useRef, useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";

export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

export interface TabRowProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  className?: string;
  layoutId?: string;
}

export function TabRow({ tabs, activeKey, onChange, className, layoutId: customLayoutId }: TabRowProps) {
  const [instanceId] = useState(() => Math.random().toString(36).slice(2, 9));
  const groupId = customLayoutId ?? instanceId;
  const reduced = useReducedMotion();

  return (
    <LayoutGroup id={`tabrow-group-${groupId}`}>
      <div
        role="tablist"
        aria-label="Tabs"
        className={cn("no-scrollbar fade-x -mx-1 flex gap-1 overflow-x-auto px-1 py-1", className)}
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => onChange(tab.key)}
              className={cn(
                "relative h-9 shrink-0 rounded-2xl px-4 text-sm font-medium whitespace-nowrap transition-colors select-none active:scale-95 cursor-pointer",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active
                  ? "text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80 dark:hover:bg-white/5"
              )}
            >
              {active && (
                <motion.span
                  layoutId={`tabrow-active-${groupId}`}
                  layoutDependency={activeKey}
                  initial={false}
                  className="absolute inset-0 rounded-pill bg-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_6px_20px_-8px_color-mix(in_oklab,var(--primary)_70%,transparent)]"
                  transition={reduced ? { duration: 0 } : SPRING_SNAPPY}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span
                    className={cn(
                      "kpi-num rounded-pill px-1.5 py-0.5 text-[11px] font-semibold",
                      active
                        ? "bg-primary-foreground/25 text-primary-foreground"
                        : "bg-foreground/8 text-muted-foreground dark:bg-white/10"
                    )}
                  >
                    {tab.count}
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

export default TabRow;
