"use client";

/**
 * BottomNav — the floating liquid pill, rendered at ALL viewports
 * (BoardOps liquid pill): always FIVE fixed slots — four destinations + "More"
 * (ADMIN: Home · Meals · Money · Residents · More;
 *  RESIDENT: Home · Meals · Billing · Payments · More).
 * Morphing shared-layout active pill with an icon pop and the label always
 * visible underneath. Fluid droplet spring physics.
 */

import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { LayoutGrid } from "lucide-react";
import type { NavItem } from "@/components/app/nav";
import { SPRING_POP, SPRING_SNAPPY, SPRING_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface BottomNavProps {
  /** The four fixed destinations (nav.bottomBarItems). */
  items: NavItem[];
  activeKey: string;
  onNavigate: (hash: string) => void;
  /** "More" slot — opens the drawer with the full nav (every viewport). */
  onMore?: () => void;
  className?: string;
}

export function BottomNav({
  items,
  activeKey,
  onNavigate,
  onMore,
  className,
}: BottomNavProps) {
  const reduced = useReducedMotion();
  const showMore = onMore != null;
  // "More" carries the active state while the route lives only in the drawer.
  const moreActive = showMore && !items.some((i) => i.key === activeKey);

  const slots = (
    <LayoutGroup id="bottom-nav-group">
      {items.map((item) => {
        const active = item.key === activeKey;
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(item.hash)}
            className="relative flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-pill px-1 transition-transform focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:scale-95 sm:px-3 cursor-pointer"
          >
            {active && (
              <motion.span
                layoutId="bottom-nav-active"
                className="absolute inset-0 rounded-pill border border-primary/30 bg-primary/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-6px_color-mix(in_oklab,var(--primary)_60%,transparent)]"
                transition={reduced ? { duration: 0 } : SPRING_SNAPPY}
              />
            )}
            <motion.span
              key={`icon-${active}`}
              initial={reduced || !active ? undefined : { scale: 0.6, y: 4 }}
              animate={{ scale: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : SPRING_POP}
              className={cn(
                "relative z-10 [&_svg]:size-[21px]",
                active
                  ? "text-primary drop-shadow-[0_0_12px_color-mix(in_oklab,var(--primary)_50%,transparent)]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon aria-hidden />
            </motion.span>
            <span
              className={cn(
                "relative z-10 max-w-full truncate text-[10px] font-semibold leading-none sm:text-[11px]",
                active ? "text-primary font-bold" : "text-muted-foreground"
              )}
            >
              {item.shortLabel ?? item.label}
            </span>
          </button>
        );
      })}
      {showMore && (
        <button
          type="button"
          aria-label="More sections"
          aria-current={moreActive ? "page" : undefined}
          onClick={onMore}
          className="relative flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-pill px-1 transition-transform focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:scale-95 sm:px-3 cursor-pointer"
        >
          {moreActive && (
            <motion.span
              layoutId="bottom-nav-active"
              className="absolute inset-0 rounded-pill border border-primary/30 bg-primary/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-6px_color-mix(in_oklab,var(--primary)_60%,transparent)]"
              transition={reduced ? { duration: 0 } : SPRING_SNAPPY}
            />
          )}
          <motion.span
            key={`icon-more-${moreActive}`}
            initial={reduced || !moreActive ? undefined : { scale: 0.6, y: 4 }}
            animate={{ scale: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : SPRING_POP}
            className={cn(
              "relative z-10 [&_svg]:size-[21px]",
              moreActive
                ? "text-primary drop-shadow-[0_0_12px_color-mix(in_oklab,var(--primary)_50%,transparent)]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <LayoutGrid aria-hidden />
          </motion.span>
          <span
            className={cn(
              "relative z-10 max-w-full truncate text-[10px] font-semibold leading-none sm:text-[11px]",
              moreActive ? "text-primary font-bold" : "text-muted-foreground"
            )}
          >
            More
          </span>
        </button>
      )}
    </LayoutGroup>
  );

  return (
    <nav
      aria-label="Primary"
      className={cn("pointer-events-none fixed inset-x-0 bottom-0 z-[var(--z-nav)]", className)}
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)" }}
    >
      <motion.div
        initial={reduced ? undefined : { y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING_SOFT, delay: 0.1, stiffness: 260, damping: 26 }}
        className={cn(
          "pointer-events-auto mx-auto w-[calc(100%-24px)]",
          "max-w-[480px] md:max-w-[560px]"
        )}
        style={{ marginBottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}
      >
        <div className="glass-nav grid auto-cols-fr grid-flow-col rounded-pill p-1.5 shadow-2xl">
          {slots}
        </div>
      </motion.div>
    </nav>
  );
}

export default BottomNav;
