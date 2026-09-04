/**
 * motion — shared Liquid Glass motion presets.
 * One source of truth for spring physics + entrance variants so every
 * surface in the app moves with the same "liquid" personality.
 *
 * Rules:
 *  - Entrances: rise + settle (never slide long distances).
 *  - Springs: soft-bouncy for surfaces, snappy for controls.
 *  - Always honour `useReducedMotion` at the call-site (variants are
 *    static; the caller decides whether to animate).
 */

import type { Transition, Variants } from "framer-motion";

/* ---- springs ---- */

/** Soft, weighty bounce — cards, sheets, panels. */
export const SPRING_SOFT: Transition = {
  type: "spring",
  stiffness: 240,
  damping: 24,
  mass: 0.9,
};

/** Snappy control feel — buttons, pills, nav indicators. */
export const SPRING_SNAPPY: Transition = {
  type: "spring",
  stiffness: 480,
  damping: 34,
};

/** Ultra-fluid liquid motion — water droplet tabs, smooth dialog expansions. */
export const SPRING_LIQUID: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 30,
  mass: 0.8,
};

/** Icon "pop" — tiny overshoot when something becomes active. */
export const SPRING_POP: Transition = {
  type: "spring",
  stiffness: 620,
  damping: 20,
};

/* ---- entrance variants ---- */

/** Rise-in: opacity + y + micro-scale. Use as `variants={riseIn}`. */
export const riseIn: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: SPRING_SOFT,
  },
};

/** Stagger container — children each use `riseIn` (or their own). */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.07, delayChildren: 0.05 },
  },
};

/** Fade only — for text swaps where movement would distract. */
export const fadeSwap: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.15, ease: "easeIn" } },
};

/* ---- helper ---- */

/** Clamp a stagger index into a sane delay range (0 – 0.4s). */
export function staggerDelay(index: number, step = 0.06, max = 0.4): number {
  return Math.min(index * step, max);
}
