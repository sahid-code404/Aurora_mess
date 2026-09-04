"use client";

/**
 * KpiCard — premium metric surface (BoardOps composition).
 * Icon orb top-left + optional ArrowUpRight "navigates" hint when the card
 * is clickable (whole-card motion button, scale/y hover lift). Animated
 * tabular numerals (spring interpolation), glow-tinted orb, opt-in
 * staggered entrance for KPI grids.
 */

import { useEffect, useMemo } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { cn } from "@/lib/utils";
import { SPRING_POP, SPRING_SOFT } from "@/lib/motion";

export interface KpiDelta {
  /** Human string, e.g. "+12.4%". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Flip semantics (e.g. expenses rising is bad). */
  inverted?: boolean;
}

export type KpiGlow = "primary" | "success" | "warning" | "danger" | "neutral" | "none";

/** Icon-orb tint (BoardOps pattern: colored orb per metric). */
export type KpiTone = "primary" | "success" | "warning" | "danger" | "neutral";

const TONE_ORB: Record<KpiTone, string> = {
  primary:
    "border-primary/25 bg-gradient-to-br from-primary/22 to-primary/6 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_18px_-8px_color-mix(in_oklab,var(--primary)_55%,transparent)]",
  success:
    "border-success/30 bg-gradient-to-br from-success/22 to-success/6 text-success shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_18px_-8px_color-mix(in_oklab,var(--success)_55%,transparent)]",
  warning:
    "border-warning/30 bg-gradient-to-br from-warning/22 to-warning/6 text-warning shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_18px_-8px_color-mix(in_oklab,var(--warning)_55%,transparent)]",
  danger:
    "border-danger/30 bg-gradient-to-br from-danger/22 to-danger/6 text-danger shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_18px_-8px_color-mix(in_oklab,var(--danger)_55%,transparent)]",
  neutral:
    "border-border/80 bg-muted/55 text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]",
};

export interface KpiCardProps {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  delta?: KpiDelta;
  /** Ambient glow tone (BoardOps pattern). */
  glow?: KpiGlow;
  /** Icon-orb tint — defaults to primary; pairs with glow for the BoardOps look. */
  tone?: KpiTone;
  /** Makes the whole card a button that navigates somewhere. */
  onClick?: () => void;
  /** Navigates to — used for the aria-label. */
  navLabel?: string;
  loading?: boolean;
  /** Stagger index for the mount animation (0-based). */
  index?: number;
  className?: string;
}

interface ParsedDisplay {
  prefix: string;
  suffix: string;
  decimals: number;
  target: number;
}

function parseDisplay(value: string): ParsedDisplay | null {
  const m = value.match(/^([^\d.-]*)(-?[\d,]+(?:\.\d+)?)([\s\S]*)$/);
  if (!m) return null;
  const [, prefix, numStr, suffix] = m;
  const target = Number(numStr.replace(/,/g, ""));
  if (!Number.isFinite(target)) return null;
  return {
    prefix,
    suffix,
    decimals: numStr.includes(".") ? (numStr.split(".")[1]?.length ?? 0) : 0,
    target,
  };
}

function AnimatedNumber({ value, className }: { value: string; className?: string }) {
  const reduced = useReducedMotion();
  const parsed = useMemo(() => parseDisplay(value), [value]);

  const motionValue = useMotionValue(parsed?.target ?? 0);
  const spring = useSpring(motionValue, { stiffness: 90, damping: 22, mass: 1.1 });
  const text = useTransform(
    spring,
    (v) =>
      `${parsed?.prefix ?? ""}${new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: parsed?.decimals ?? 0,
        maximumFractionDigits: parsed?.decimals ?? 0,
      }).format(v)}${parsed?.suffix ?? ""}`
  );

  useEffect(() => {
    if (parsed) motionValue.set(parsed.target);
  }, [motionValue, parsed]);

  if (!parsed || reduced) {
    return <span className={className}>{value}</span>;
  }

  return <motion.span className={className}>{text}</motion.span>;
}

function DeltaChip({ delta }: { delta: KpiDelta }) {
  const Icon =
    delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  const good =
    delta.direction === "flat"
      ? null
      : delta.inverted
        ? delta.direction === "down"
        : delta.direction === "up";
  return (
    <motion.span
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={SPRING_POP}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-pill border px-1.5 py-0.5 text-[11px] font-semibold",
        good === null && "border-border bg-muted/60 text-muted-foreground",
        good === true && "border-success/30 bg-success/12 text-success",
        good === false && "border-danger/30 bg-danger/12 text-danger"
      )}
    >
      <Icon className="size-3" aria-hidden />
      {delta.value}
    </motion.span>
  );
}

const GLOW_CLASS: Record<KpiGlow, string> = {
  primary: "glow-primary",
  success: "glow-success",
  warning: "glow-warning",
  danger: "glow-danger",
  neutral: "",
  none: "",
};

function getKpiFontSize(val: string): string {
  const len = val.trim().length;
  if (len <= 3) return "text-2xl sm:text-[26px]";
  if (len <= 5) return "text-xl sm:text-2xl";
  if (len <= 8) return "text-lg sm:text-xl";
  if (len <= 11) return "text-base sm:text-lg";
  return "text-sm sm:text-base";
}

export function KpiCard({
  label,
  value,
  sub,
  icon,
  delta,
  glow = "none",
  tone = "primary",
  onClick,
  navLabel,
  loading = false,
  index = 0,
  className,
}: KpiCardProps) {
  const fontSizeClass = useMemo(() => getKpiFontSize(value), [value]);

  if (loading) {
    return <KpiSkeleton className={className} />;
  }

  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        {icon ? (
          <motion.span
            aria-hidden
            whileHover={{ scale: 1.1, rotate: -4 }}
            transition={SPRING_POP}
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-2xl border [&_svg]:size-5",
              TONE_ORB[tone]
            )}
          >
            {icon}
          </motion.span>
        ) : (
          <span />
        )}
        {onClick && <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      </div>
      <p className="mt-2.5 truncate text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <AnimatedNumber
        value={value}
        className={cn(
          "kpi-num font-display mt-1 block truncate font-bold tracking-tight leading-tight transition-all duration-200",
          fontSizeClass
        )}
      />
      {(delta || sub) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
          {delta && <DeltaChip delta={delta} />}
          {sub && <span className="truncate">{sub}</span>}
        </div>
      )}
    </>
  );

  const classes = cn(
    "group p-4 rounded-3xl",
    GLOW_CLASS[glow],
    className
  );

  if (onClick) {
    return (
      <motion.button
        type="button"
        onClick={onClick}
        aria-label={navLabel ? `${label} — open ${navLabel}` : label}
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...SPRING_SOFT, delay: Math.min(0.06 + index * 0.08, 0.4) }}
        whileHover={{ y: -3, scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={cn("glass cursor-pointer rounded-3xl text-left select-none", "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", classes)}
      >
        {content}
      </motion.button>
    );
  }

  return (
    <GlassCard
      entrance
      entranceDelay={Math.min(0.06 + index * 0.08, 0.4)}
      className={classes}
    >
      {content}
    </GlassCard>
  );
}

/** Skeleton variant so layouts hold their shape while data loads. */
export function KpiSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("glass rounded-3xl p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="glass-skeleton size-10 rounded-2xl" />
        <div className="glass-skeleton size-4 rounded" />
      </div>
      <div className="glass-skeleton mt-2.5 h-3 w-24" />
      <div className="glass-skeleton mt-1 h-7 w-32" />
      <div className="glass-skeleton mt-1 h-2.5 w-20" />
    </div>
  );
}

export default KpiCard;
