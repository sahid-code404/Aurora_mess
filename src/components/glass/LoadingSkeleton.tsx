import { cn } from "@/lib/utils";

/**
 * LoadingSkeleton — shimmering glass blocks (`.glass-skeleton`).
 * Composable primitives + a KPI grid preset. Rows and grid children
 * stagger in with the CSS `anim-rise` entrance (0.05–0.06s steps, capped)
 * so loading layouts cascade the same way loaded ones do.
 * Server-safe: everything is pure CSS (respects prefers-reduced-motion).
 */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("glass-skeleton", className)} />;
}

export function SkeletonLine({ className }: { className?: string }) {
  return <div aria-hidden className={cn("glass-skeleton h-3 rounded-full", className)} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("glass rounded-lg p-4 sm:p-5", className)}>
      <div className="space-y-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

export function KpiGridSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  const gridClass = count === 3 ? "grid grid-cols-3 gap-2 sm:gap-3" : "grid-kpi gap-2.5 sm:gap-3";
  return (
    <div
      className={cn(gridClass, className)}
      aria-label="Loading"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="anim-rise"
          style={{ animationDelay: `${Math.min(i * 0.06, 0.36)}s` }}
        >
          <SkeletonCard />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5", className)} aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="glass-inset anim-rise flex items-center gap-3 rounded-md p-3.5"
          style={{ animationDelay: `${Math.min(i * 0.05, 0.3)}s` }}
        >
          <Skeleton className="size-10 rounded-pill" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
          <Skeleton className="h-6 w-16 rounded-pill" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
