import { cn } from "@/lib/utils";

/**
 * EmptyState — quiet glass panel for lists with nothing to show.
 * Icon floats gently inside a tinted primary orb, plain-language copy,
 * optional action slot. Server-safe: the float + entrance are pure CSS
 * (respect prefers-reduced-motion globally).
 */

import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "glass-inset anim-rise flex flex-col items-center justify-center rounded-lg px-6 py-12 text-center",
        className
      )}
    >
      {Icon && (
        <span aria-hidden className="float-y mb-4">
          <span className="flex size-16 items-center justify-center rounded-full border border-primary/25 bg-gradient-to-br from-primary/22 to-primary/6 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_12px_32px_-12px_color-mix(in_oklab,var(--primary)_45%,transparent)] [&_svg]:size-6">
            <Icon />
          </span>
        </span>
      )}
      <p className="font-display text-sm font-semibold">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export default EmptyState;
