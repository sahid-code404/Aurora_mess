"use client";

/**
 * GlassToggle — iOS-style ON/OFF switch for meal opt-in.
 * Spring thumb (SPRING_SNAPPY x-slide), the checked track crossfades to
 * the mint primary gradient with a tinted glow (matching GlassButton's
 * solid treatment), icon crossfade. Accessible: role="switch",
 * aria-checked, keyboard (Space/Enter native), disabled state, visible
 * focus ring, 44px touch target.
 */

import { motion, useReducedMotion } from "framer-motion";
import { Check, X } from "lucide-react";
import { SPRING_SNAPPY } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface GlassToggleProps {
  checked: boolean;
  onChange: (next: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Optional click handler invoked when user taps while disabled. */
  onDisabledClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Accessible label — required when no visible label is adjacent. */
  label: string;
  /** Show check/cross icons inside the track (default true). */
  icons?: boolean;
  className?: string;
}

const TRACK_W = 52;
const TRACK_H = 31;
const THUMB = 25;
const TRAVEL = TRACK_W - THUMB - 6; // 3px inset each side

/** Mint gradient + glow, matching GlassButton's primary fill. */
const ON_TRACK_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(157deg, color-mix(in oklab, var(--primary) 84%, white 16%) 0%, var(--primary) 52%, color-mix(in oklab, var(--primary) 86%, black 14%) 100%)",
  boxShadow:
    "0 6px 18px -6px color-mix(in oklab, var(--primary) 60%, transparent), inset 0 1px 0 rgba(255,255,255,0.28)",
};

export function GlassToggle({
  checked,
  onChange,
  disabled = false,
  onDisabledClick,
  label,
  icons = true,
  className,
}: GlassToggleProps) {
  const reduced = useReducedMotion();
  const fade = reduced ? { duration: 0 } : { duration: 0.18 };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      if (onDisabledClick) {
        e.stopPropagation();
        onDisabledClick(e);
      }
      return;
    }
    onChange(!checked, e);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled && !onDisabledClick}
      onClick={handleClick}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-pill",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
      style={{ width: TRACK_W, height: TRACK_H }}
    >
      {/* off track — quiet inset glass */}
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-pill border"
        style={{
          backgroundColor: "color-mix(in oklab, var(--foreground) 12%, transparent)",
          borderColor: "var(--glass-inset-border)",
        }}
        animate={{ opacity: checked ? 0 : 1 }}
        transition={fade}
      />
      {/* on track — primary gradient + glow */}
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-pill border border-primary/40"
        style={ON_TRACK_STYLE}
        animate={{ opacity: checked ? 1 : 0 }}
        transition={fade}
      />
      {/* crossfading icons */}
      {icons && (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1.5 flex items-center">
          <motion.span
            className="flex items-center justify-center text-primary-foreground"
            animate={{ opacity: checked ? 1 : 0, scale: checked ? 1 : 0.6 }}
            transition={fade}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        </span>
      )}
      {icons && (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
          <motion.span
            className="flex items-center justify-center text-muted-foreground"
            animate={{ opacity: checked ? 0 : 1, scale: checked ? 0.6 : 1 }}
            transition={fade}
          >
            <X className="size-3" strokeWidth={3} />
          </motion.span>
        </span>
      )}
      {/* thumb */}
      <motion.span
        aria-hidden
        className="absolute left-[3px] top-1/2 flex size-[25px] -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] dark:bg-[#E9EDEF]"
        animate={{ x: checked ? TRAVEL : 0 }}
        transition={reduced ? { duration: 0 } : SPRING_SNAPPY}
      />
    </button>
  );
}

export default GlassToggle;
