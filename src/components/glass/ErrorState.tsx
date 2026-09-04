"use client";

/**
 * ErrorState — friendly failure surface derived from a domain error code.
 * The danger-tinted orb pops in with a springy wobble (scale + rotate
 * settle), retry is a GlassButton, and a short mono code chip stays quiet
 * for support/debugging.
 */

import { motion, useReducedMotion } from "framer-motion";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { GlassButton } from "./GlassButton";
import { SPRING_POP } from "@/lib/motion";
import { cn } from "@/lib/utils";

const CODE_COPY: Record<string, string> = {
  NETWORK: "We couldn't reach the server. Check your connection and try again.",
  UNAUTHENTICATED: "Your session has expired. Please sign in again.",
  FORBIDDEN: "You don't have access to this area.",
  NOT_FOUND: "We couldn't find what you were looking for.",
  RESOURCE_CHANGED: "This changed while you were working. Refresh and try again.",
  RATE_LIMITED: "Too many attempts in a short time. Please wait a moment and try again.",
};

export interface ErrorStateProps {
  code?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ code, message, onRetry, className }: ErrorStateProps) {
  const reduced = useReducedMotion();
  const copy =
    message ??
    (code && CODE_COPY[code]) ??
    "Something went wrong on our side. Please try again — if it keeps happening, tell the admin.";

  return (
    <div
      role="alert"
      className={cn(
        "glass-inset anim-rise flex flex-col items-center justify-center rounded-lg px-6 py-10 text-center",
        className
      )}
    >
      <motion.span
        initial={reduced ? false : { scale: 0.5, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={reduced ? { duration: 0 } : SPRING_POP}
        className="mb-4 flex size-13 shrink-0 items-center justify-center rounded-xl border border-danger/30 bg-gradient-to-br from-danger/22 to-danger/6 text-danger shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-10px_color-mix(in_oklab,var(--danger)_55%,transparent)] [&_svg]:size-6"
      >
        <TriangleAlert aria-hidden />
      </motion.span>
      <p className="max-w-md text-sm font-medium">{copy}</p>
      <div className="mt-3 flex items-center gap-3">
        {code && (
          <code className="glass-inset kpi-num rounded-pill px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {code}
          </code>
        )}
        {onRetry && (
          <GlassButton variant="secondary" size="sm" icon={<RotateCcw />} onClick={onRetry}>
            Try again
          </GlassButton>
        )}
      </div>
    </div>
  );
}

export default ErrorState;
