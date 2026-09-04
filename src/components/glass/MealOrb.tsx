"use client";

/**
 * MealOrb — BoardOps circular gradient meal icon (user-meals-view pattern).
 * A saturated 135° gradient disc with a dark-tinted glyph, a top inner
 * highlight and a soft coloured glow — breakfast amber, lunch emerald,
 * dinner teal, mapped from the API colorToken. Liquid-glass compatible:
 * the disc reads as a solid glass "pill button" like GlassToggle's ON track.
 */

import { cn } from "@/lib/utils";

export type MealOrbToken = "amber" | "emerald" | "frost" | "rose" | "sky" | "violet";

/** colorToken → gradient disc + glyph tint + glow (NO blue/indigo). */
const ORB: Record<MealOrbToken, string> = {
  amber:
    "bg-gradient-to-br from-amber-300 to-amber-500 text-amber-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(245,158,11,0.55)]",
  emerald:
    "bg-gradient-to-br from-emerald-300 to-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(16,185,129,0.55)]",
  sky: "bg-gradient-to-br from-teal-300 to-teal-500 text-teal-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(13,148,136,0.55)]",
  frost:
    "bg-gradient-to-br from-primary/75 to-primary text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_color-mix(in_oklab,var(--primary)_50%,transparent)]",
  rose:
    "bg-gradient-to-br from-rose-300 to-rose-500 text-rose-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(244,63,94,0.55)]",
  violet:
    "bg-gradient-to-br from-fuchsia-300 to-fuchsia-500 text-fuchsia-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(217,70,239,0.55)]",
};

export function mealOrbToken(colorToken: string | null | undefined): MealOrbToken {
  if (!colorToken) return "frost";
  const key = colorToken.toLowerCase();
  return key === "amber" || key === "emerald" || key === "sky" || key === "frost" || key === "rose" || key === "violet"
    ? (key as MealOrbToken)
    : "frost";
}

export interface MealOrbProps {
  /** Lucide icon node (e.g. <MealIcon name={…} /> or <Coffee />). */
  icon: React.ReactNode;
  /** API colorToken — amber/emerald/sky/frost/rose/violet (default frost). */
  colorToken?: string | null;
  /** Disc diameter: sm 36px · md 48px · lg 56px. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZES: Record<NonNullable<MealOrbProps["size"]>, string> = {
  sm: "size-9 [&_svg]:size-4",
  md: "size-12 [&_svg]:size-5",
  lg: "size-14 [&_svg]:size-6",
};

export function MealOrb({ icon, colorToken, size = "md", className }: MealOrbProps) {
  const orbClass = ORB[mealOrbToken(colorToken)];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        SIZES[size],
        orbClass,
        className
      )}
    >
      {icon}
    </span>
  );
}

export default MealOrb;
