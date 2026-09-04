"use client";

/**
 * NotifStack — Apple/iOS-style grouped notification stack (Liquid Glass).
 *
 * Design (mirrors iOS notification stacks):
 *  - One CONTINUOUS glass container per group — rows are separated by
 *    hairline dividers and never float apart (no "disconnected cards").
 *  - The first `visibleRows` rows (default 5) always show. Anything beyond
 *    folds into a physical stack: up to `peek` glass cards peek 12px each
 *    behind the container's bottom edge, progressively dimmer.
 *  - Tapping the "+N more" strip springs the stack OPEN — the folded rows
 *    unfurl downward (staggered height+opacity springs) while the peek
 *    layers fade away; a quiet "Show less" strip folds it back.
 *  - While the page scrolls the stack SLIDES: the peek layers physically
 *    drag — fanning out when scrolling down, tucking in when scrolling
 *    back up — and spring back to rest the moment you stop
 *    (scroll-velocity driven, disabled under prefers-reduced-motion).
 *  - Row anatomy: tone orb → title + time (right) + unread dot, message
 *    underneath. Tapping a row marks it read (call-site behavior), or
 *    fires `onRowTap` when provided.
 *
 * Accessibility: the strip is a real button with aria-expanded; peek
 * layers are aria-hidden; every row keeps a descriptive aria-label;
 * springs degrade to instant swaps under prefers-reduced-motion.
 */

import { useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { SPRING_SNAPPY, staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface NotifStackItem {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  readAt?: string | null;
}

export interface NotifStackProps {
  /** Newest-first notifications for this group. */
  items: NotifStackItem[];
  /** Icon per notification type. */
  iconFor: (type: string) => LucideIcon;
  /** Tailwind tint classes for the icon orb per type. */
  toneFor: (type: string) => string;
  /** Compact clock label (e.g. "4:17 pm" / "2h ago"). */
  timeFor: (createdAt: string) => string;
  /** Row tap behavior — mark read (only fires for unread rows). */
  onMarkRead?: (id: string) => void;
  /** Row tap behavior for EVERY row (e.g. a detail toast). Takes over
   *  mark-read taps when provided. */
  onRowTap?: (item: NotifStackItem) => void;
  /** Group label for aria descriptions ("Today"). */
  label?: string;
  /** Rows shown before the rest fold into the stack. */
  visibleRows?: number;
  /** Max peeking cards behind the container. */
  peek?: number;
  /** Mount entrance delay (seconds) for list stagger. */
  entranceDelay?: number;
  className?: string;
}

interface RowSkin {
  toneFor: (type: string) => string;
  timeFor: (createdAt: string) => string;
  /** Icon component resolved by the parent (passed as prop for lint-clean static rendering). */
  icon: LucideIcon;
}

/** Shared row body — used by every row in the connected container. */
function RowContent({ item, icon: Icon, toneFor, timeFor }: RowSkin & { item: NotifStackItem }) {
  const unread = item.readAt == null;
  return (
    <div className="flex items-start gap-3 p-4">
      <span
        aria-hidden
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl border",
          toneFor(item.type),
          !unread && "opacity-70"
        )}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium leading-tight",
              !unread && "text-muted-foreground"
            )}
          >
            {item.title}
          </span>
          <span className="kpi-num shrink-0 text-[11px] text-muted-foreground/80">
            {timeFor(item.createdAt)}
          </span>
          {unread && <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />}
        </div>
        <p className="mt-0.5 text-left text-xs leading-relaxed text-muted-foreground">
          {item.message}
        </p>
      </div>
    </div>
  );
}

/** One row inside the expanded connected container. */
function StackRow({
  item,
  divided,
  onMarkRead,
  onRowTap,
  ...skin
}: RowSkin & {
  item: NotifStackItem;
  divided?: boolean;
  onMarkRead?: (id: string) => void;
  onRowTap?: (item: NotifStackItem) => void;
}) {
  const unread = item.readAt == null;
  const clickable = Boolean(onRowTap) || (unread && Boolean(onMarkRead));
  const content = <RowContent item={item} {...skin} />;

  if (!clickable) {
    return <div className={cn(divided && "border-t border-foreground/10")}>{content}</div>;
  }

  const label = onRowTap
    ? `${item.title}. ${item.message}`
    : `${unread ? "Unread" : "Read"}: ${item.title}. ${item.message}`;

  return (
    <motion.button
      type="button"
      onClick={() => (onRowTap ? onRowTap(item) : onMarkRead?.(item.id))}
      aria-label={label}
      className={cn(
        "w-full cursor-pointer text-left transition-colors",
        "hover:bg-foreground/5 active:bg-foreground/10",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
        divided && "border-t border-foreground/10"
      )}
    >
      {content}
    </motion.button>
  );
}

export function NotifStack({
  items,
  iconFor,
  toneFor,
  timeFor,
  onMarkRead,
  onRowTap,
  label,
  visibleRows = 5,
  entranceDelay = 0,
  className,
}: NotifStackProps) {
  const [expanded, setExpanded] = useState(items.length <= visibleRows);
  const reduced = useReducedMotion();

  if (items.length === 0) return null;

  const visible = Math.min(visibleRows, items.length);
  const hidden = items.length - visible;
  const collapsible = hidden > 0;
  const folded = collapsible && !expanded;

  const unfurl = (idx: number) =>
    reduced
      ? { duration: 0.01 }
      : { ...SPRING_SNAPPY, delay: staggerDelay(idx, 0.05, 0.35) };
  const fold = { height: 0, opacity: 0, transition: { duration: 0.16, ease: "easeIn" as const } };

  const rowSkin = (item: NotifStackItem) => ({
    icon: iconFor(item.type),
    toneFor,
    timeFor,
  });

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{
        opacity: 1,
        y: 0,
      }}
      transition={reduced ? { duration: 0 } : { ...SPRING_SNAPPY, delay: entranceDelay }}
      className={cn("relative", className)}
    >
      {/* one continuous glass container — hairline-connected rows */}
      <div className="glass relative z-10 overflow-hidden rounded-lg">
        {/* always-visible rows (first `visible`) */}
        <StackRow item={items[0]} {...rowSkin(items[0])} onMarkRead={onMarkRead} onRowTap={onRowTap} />
        {items.slice(1, visible).map((n) => (
          <StackRow key={n.id} item={n} {...rowSkin(n)} divided onMarkRead={onMarkRead} onRowTap={onRowTap} />
        ))}

        {/* folded rows — spring open ("stack opens in animation") */}
        <AnimatePresence initial={false}>
          {expanded &&
            items.slice(visible).map((n, i) => (
              <motion.div
                key={n.id}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={fold}
                transition={unfurl(i)}
                className="overflow-hidden"
              >
                <StackRow item={n} {...rowSkin(n)} divided onMarkRead={onMarkRead} onRowTap={onRowTap} />
              </motion.div>
            ))}
        </AnimatePresence>

        {/* fold strip — "+N more" opens the stack, "Show less" folds it */}
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-label={
              folded
                ? `Show ${hidden} more${label ? ` from ${label}` : ""}`
                : `Fold ${label ?? "stack"} back`
            }
            className={cn(
              "group flex w-full cursor-pointer items-center justify-center gap-1 border-t border-foreground/10 py-2.5",
              "text-[11px] font-semibold text-muted-foreground/80 transition-colors",
              "hover:bg-foreground/5 hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
            )}
          >
            {folded ? (
              <>
                <ChevronDown
                  className="size-3.5 transition-transform duration-200 group-hover:translate-y-0.5"
                  aria-hidden
                />
                {`+${hidden} more`}
              </>
            ) : (
              <>
                <ChevronUp
                  className="size-3.5 transition-transform duration-200 group-hover:-translate-y-0.5"
                  aria-hidden
                />
                Show less
              </>
            )}
          </button>
        )}
      </div>
    </motion.div>
  );
}

export default NotifStack;
