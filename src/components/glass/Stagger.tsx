"use client";

/**
 * Stagger — BoardOps-Fresh page entrance primitives, ported to the
 * Liquid Glass motion system.
 *
 * Wraps a page's top-level sections so they rise in one after another
 * (subtle y+scale springs, ~45ms apart). This is the reference project's
 * signature page rhythm (StaggerGroup/StaggerItem) tuned to our tokens:
 *  - subtle travel (y: 8, scale: 0.99) because the route-level transition
 *    already carries the heavier 18px rise;
 *  - snappy spring settle;
 *  - reduced-motion renders instantly (no variants).
 *
 * Usage:
 *   <StaggerGroup className="space-y-4">
 *     <StaggerItem>…KPI grid…</StaggerItem>
 *     <StaggerItem>…filter pills…</StaggerItem>
 *     <StaggerItem>…list…</StaggerItem>
 *   </StaggerGroup>
 */

import type { ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";

const GROUP: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.03 } },
};

const ITEM: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.18, ease: "easeOut" } },
};

export function StaggerGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      variants={GROUP}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div variants={ITEM} className={cn(className)}>
      {children}
    </motion.div>
  );
}
