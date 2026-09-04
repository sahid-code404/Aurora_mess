"use client";

/**
 * GlassButton — tactile Liquid Glass action button.
 * Variants: primary (mint gradient + glow) · secondary (glass) · ghost ·
 * destructive. Fully pill-rounded, min height 44px (md), spring press,
 * specular top highlight.
 */

import { forwardRef } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPRING_SNAPPY } from "@/lib/motion";

export type GlassButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type GlassButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<GlassButtonVariant, string> = {
  primary: "text-primary-foreground",
  secondary: "glass text-foreground hover:border-glass-border-strong",
  ghost:
    "border border-transparent text-foreground hover:bg-foreground/6 dark:hover:bg-white/6",
  destructive: "text-destructive-foreground",
};

/** Gradient fill + tinted glow for the solid variants. */
const SOLID_STYLES: Record<"primary" | "destructive", React.CSSProperties> = {
  primary: {
    backgroundImage:
      "linear-gradient(157deg, color-mix(in oklab, var(--primary) 84%, white 16%) 0%, var(--primary) 52%, color-mix(in oklab, var(--primary) 86%, black 14%) 100%)",
    boxShadow: "var(--shadow-primary-glow)",
  },
  destructive: {
    backgroundImage:
      "linear-gradient(157deg, color-mix(in oklab, var(--destructive) 84%, white 16%) 0%, var(--destructive) 52%, color-mix(in oklab, var(--destructive) 86%, black 14%) 100%)",
    boxShadow:
      "0 10px 32px -10px color-mix(in oklab, var(--destructive) 60%, transparent)",
  },
};

const SIZE_CLASSES: Record<GlassButtonSize, string> = {
  sm: "h-9 px-4 text-sm gap-1.5 rounded-2xl",
  md: "h-11 px-5 text-sm gap-2 rounded-2xl",
  lg: "h-13 px-7 text-base gap-2.5 rounded-3xl",
};

export interface GlassButtonProps
  extends Omit<HTMLMotionProps<"button">, "children" | "ref"> {
  variant?: GlassButtonVariant;
  size?: GlassButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  children?: React.ReactNode;
  /** Optional leading icon. */
  icon?: React.ReactNode;
}

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  function GlassButton(
    {
      variant = "primary",
      size = "md",
      loading = false,
      fullWidth = false,
      className,
      children,
      icon,
      disabled,
      type,
      style,
      ...rest
    },
    ref
  ) {
    const isSolid = variant === "primary" || variant === "destructive";

    return (
      <motion.button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        whileHover={disabled || loading ? undefined : { y: -1.5, scale: 1.015 }}
        whileTap={disabled || loading ? undefined : { scale: 0.968, y: 0.5 }}
        transition={SPRING_SNAPPY}
        style={{ ...(isSolid ? SOLID_STYLES[variant] : null), ...style }}
        className={cn(
          "relative inline-flex select-none items-center justify-center overflow-hidden",
          "font-medium tracking-tight transition-[box-shadow,border-color,color]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:pointer-events-none disabled:opacity-60",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          fullWidth && "w-full",
          className
        )}
        {...rest}
      >
        {/* specular top highlight */}
        {isSolid && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-[inherit]"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.36), rgba(255,255,255,0.05))",
            }}
          />
        )}
        {loading ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <span className="invisible">{children}</span>
          </>
        ) : (
          <>
            {icon && (
              <span aria-hidden className="shrink-0 [&_svg]:size-4">
                {icon}
              </span>
            )}
            {children}
          </>
        )}
      </motion.button>
    );
  }
);

export default GlassButton;
