"use client";

/**
 * GlassCard — the workhorse Liquid Glass surface.
 * Materials: `glass` / `glass-strong` / `glass-inset`.
 * - `interactive` → spring hover lift + press, button semantics
 * - `entrance`    → opt-in rise-in mount animation (pass entranceDelay to
 *                   stagger grids). Non-interactive cards animate via the
 *                   `.anim-rise` CSS keyframe (server-cheap); interactive
 *                   cards animate via a framer spring (so the delay can't be
 *                   masked by the CSS keyframe firing at 0s).
 */

import { motion, type HTMLMotionProps } from "framer-motion";
import { cn } from "@/lib/utils";
import { SPRING_SOFT, SPRING_SNAPPY } from "@/lib/motion";

export interface GlassCardProps extends Omit<HTMLMotionProps<"div">, "children"> {
  children?: React.ReactNode;
  /** Enable tactile hover/press motion + button semantics (requires onClick). */
  interactive?: boolean;
  /** Use the denser material (dialogs, hero panels). */
  strong?: boolean;
  /** Nested surface — no backdrop-filter (use inside another glass card). */
  inset?: boolean;
  /** Animate in on mount with a rise + settle. */
  entrance?: boolean;
  /** Stagger helper for entrance (seconds). */
  entranceDelay?: number;
}

export function GlassCard({
  interactive = false,
  strong = false,
  inset = false,
  entrance = false,
  entranceDelay = 0,
  className,
  children,
  onClick,
  ...rest
}: GlassCardProps) {
  const material = inset
    ? "glass-inset"
    : strong
      ? "glass-strong"
      : "glass";

  const isInteractive = interactive || Boolean(onClick);

  if (!isInteractive || !onClick) {
    return (
      <div
        onClick={onClick}
        className={cn(
          material,
          "rounded-3xl",
          entrance && "anim-rise",
          className
        )}
        style={
          entrance && entranceDelay
            ? { animationDelay: `${entranceDelay}s` }
            : undefined
        }
        {...(rest as React.ComponentProps<"div">)}
      >
        {children}
      </div>
    );
  }

  return (
    <motion.div
      role="button"
      tabIndex={0}
      initial={entrance ? { opacity: 0, y: 18, scale: 0.985 } : undefined}
      animate={entrance ? { opacity: 1, y: 0, scale: 1 } : undefined}
      transition={
        entrance
          ? { ...SPRING_SOFT, delay: entranceDelay }
          : SPRING_SNAPPY
      }
      whileHover={{ y: -3, scale: 1.008 }}
      whileTap={{ scale: 0.982 }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (onClick as (e: React.MouseEvent<HTMLDivElement>) => void)(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      }}
      className={cn(
        material,
        "rounded-3xl",
        "cursor-pointer select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export default GlassCard;
