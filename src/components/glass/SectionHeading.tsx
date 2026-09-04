import { cn } from "@/lib/utils";

/**
 * SectionHeading — small quiet group label with an optional action slot.
 * Server-safe.
 */

export interface SectionHeadingProps {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeading({ children, action, className }: SectionHeadingProps) {
  return (
    <div className={cn("anim-rise flex items-center justify-between gap-3", className)}>
      <h2 className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        <span
          aria-hidden
          className="block h-3.5 w-1 rounded-pill bg-gradient-to-b from-primary/70 to-primary/25"
        />
        {children}
      </h2>
      {action}
    </div>
  );
}

export default SectionHeading;
