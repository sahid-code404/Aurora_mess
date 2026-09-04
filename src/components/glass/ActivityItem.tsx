"use client";

/**
 * ActivityItem — one row in an activity/timeline feed.
 * Primary-tinted icon orb, optional pulsing unread dot, spring hover lift
 * (y: -2) and a subtle staggered entrance (pass `index` from list maps).
 */

import { motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { SPRING_SNAPPY } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ActivityItemProps {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  time?: React.ReactNode;
  /** Trailing badge / status / amount. */
  trailing?: React.ReactNode;
  /** Renders a pulsing unread dot next to the title. */
  unread?: boolean;
  /** Stagger index for the mount entrance (0-based; delays capped at 0.3s). */
  index?: number;
  className?: string;
}

export function ActivityItem({
  icon: Icon,
  title,
  description,
  time,
  trailing,
  unread = false,
  index = 0,
  className,
}: ActivityItemProps) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduced ? { duration: 0 } : { ...SPRING_SNAPPY, delay: Math.min(index * 0.05, 0.3) }
      }
      whileHover={reduced ? undefined : { y: -2 }}
      className={cn("glass-inset flex items-start gap-3 rounded-md p-3", className)}
    >
      {Icon && (
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/22 to-primary/6 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_18px_-8px_color-mix(in_oklab,var(--primary)_55%,transparent)] [&_svg]:size-[18px]"
        >
          <Icon />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium leading-tight">
          {unread && (
            <span
              aria-label="Unread"
              className="pulse-dot size-2 shrink-0 rounded-full bg-primary text-primary"
            />
          )}
          {title}
        </p>
        {description && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
        )}
        {time && (
          <p className="kpi-num mt-1 text-[11px] text-muted-foreground/80">{time}</p>
        )}
      </div>
      {trailing && <div className="shrink-0 self-center">{trailing}</div>}
    </motion.div>
  );
}

export default ActivityItem;
