"use client";

/**
 * SplashScreen — Cinematic Liquid Glass entrance screen for BoardOps.
 *
 * Visual anatomy:
 *   - Ambient floating aurora backdrops with soft organic breathing glow.
 *   - Centered floating glass shield with specular highlights and specular gleam.
 *   - High-fidelity logo emblem with soft spring scale.
 *   - "Aurora Mess" title with liquid gradient sheen.
 *   - Subtle pulsing status beam for a tactile launch feel.
 *   - Graceful scale + dissolve exit sequence.
 */

import { motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { SPRING_SOFT, SPRING_LIQUID } from "@/lib/motion";

export interface SplashScreenProps {
  message?: string;
  onExitComplete?: () => void;
}

export function SplashScreen({ message = "Preparing your workspace…" }: SplashScreenProps) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      key="splash-screen"
      initial={reduced ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={
        reduced
          ? { opacity: 0 }
          : {
              opacity: 0,
              scale: 1.04,
              filter: "blur(8px)",
              transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
            }
      }
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background select-none"
    >
      {/* Dynamic ambient background canopy */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {/* Glowing radial aurora blooms */}
        <motion.div
          animate={
            reduced
              ? undefined
              : {
                  scale: [1, 1.12, 1],
                  opacity: [0.35, 0.55, 0.35],
                }
          }
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[460px] rounded-full bg-primary/20 blur-[90px]"
        />
        <motion.div
          animate={
            reduced
              ? undefined
              : {
                  scale: [1.1, 0.95, 1.1],
                  opacity: [0.2, 0.4, 0.2],
                }
          }
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
          className="absolute top-1/2 left-1/2 -translate-x-[40%] -translate-y-[60%] size-[380px] rounded-full bg-gold/15 blur-[80px]"
        />
      </div>

      {/* Central Glass Portal Card */}
      <div className="relative z-10 flex flex-col items-center gap-7 px-6 text-center max-w-sm">
        {/* Floating emblem with liquid glass ring */}
        <motion.div
          initial={reduced ? undefined : { scale: 0.8, y: 16, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          transition={{ ...SPRING_LIQUID, delay: 0.05 }}
          className="relative group"
        >
          {/* Ambient backlight glow */}
          <div className="absolute -inset-2 rounded-[32px] bg-gradient-to-tr from-primary/30 to-gold/30 blur-xl opacity-75 group-hover:opacity-100 transition-opacity" />

          {/* Liquid glass shield */}
          <div className="relative flex size-28 items-center justify-center rounded-[28px] border border-white/20 dark:border-white/15 bg-white/10 dark:bg-white/[0.06] backdrop-blur-2xl shadow-[0_24px_50px_-12px_rgba(0,0,0,0.5),inset_0_1.5px_1px_rgba(255,255,255,0.4)]">
            <motion.div
              animate={reduced ? undefined : { scale: [1, 1.04, 1] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              className="relative flex items-center justify-center"
            >
              <img
                src="/logo-mark.png"
                alt="Aurora Mess"
                width={64}
                height={64}
                className="size-16 rounded-2xl object-cover shadow-md"
              />
            </motion.div>

            {/* Specular sheen swipe */}
            <div className="absolute inset-0 rounded-[28px] overflow-hidden pointer-events-none">
              <motion.div
                animate={
                  reduced
                    ? undefined
                    : {
                        x: ["-100%", "200%"],
                      }
                }
                transition={{
                  repeat: Infinity,
                  duration: 2.8,
                  ease: "easeInOut",
                  repeatDelay: 1.2,
                }}
                className="w-1/2 h-full bg-gradient-to-r from-transparent via-white/20 to-transparent skew-x-[-20deg]"
              />
            </div>
          </div>
        </motion.div>

        {/* Branding header */}
        <motion.div
          initial={reduced ? undefined : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING_SOFT, delay: 0.18 }}
          className="space-y-2"
        >
          <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 bg-primary/10 border border-primary/25 text-primary text-[11px] font-semibold tracking-wider uppercase mb-1">
            <Sparkles className="size-3" aria-hidden />
            <span>Liquid Glass</span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            Aurora <span className="text-liquid">Mess</span>
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground font-medium">
            Meals, money &amp; operations — beautifully kept.
          </p>
        </motion.div>

        {/* Tactile progress bar */}
        <motion.div
          initial={reduced ? undefined : { opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.28, duration: 0.3 }}
          className="w-48 flex flex-col items-center gap-2.5 pt-1"
        >
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-foreground/10 dark:bg-white/10">
            <motion.div
              animate={
                reduced
                  ? undefined
                  : {
                      x: ["-100%", "100%"],
                    }
              }
              transition={{
                repeat: Infinity,
                duration: 1.4,
                ease: "easeInOut",
              }}
              className="h-full w-2/3 rounded-full bg-gradient-to-r from-primary/40 via-primary to-primary/40 shadow-[0_0_12px_var(--primary)]"
            />
          </div>
          <motion.p
            animate={reduced ? undefined : { opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            className="text-[11px] font-medium tracking-wide text-muted-foreground/85"
          >
            {message}
          </motion.p>
        </motion.div>
      </div>
    </motion.div>
  );
}

export default SplashScreen;
