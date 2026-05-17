import { Loader2 } from 'lucide-react';

/**
 * Animated grey block used as a placeholder while data is loading for
 * the first time. Width/height set by caller via Tailwind classes.
 *
 *   <Skeleton className="h-10 w-32" />
 */
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={'animate-pulse rounded bg-border/40 ' + className} />;
}

/**
 * Quiet "still refreshing" badge. Mount inside a SectionHeader meta slot
 * during a refetch where stale content is already on screen, so the user
 * sees activity without losing context.
 */
export function RefreshDot({ visible }: { visible: boolean }): JSX.Element | null {
  if (!visible) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted font-mono">
      <Loader2 size={11} className="animate-spin" /> refreshing…
    </span>
  );
}

/**
 * Generic centered "loading…" panel for the cold-start case (no cached
 * data yet). Keep KPI/skeleton block proportions roughly equal to the
 * real page so layout doesn't jump on first paint.
 */
export function PageSkeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div className="space-y-6 max-w-screen-2xl">
      <Skeleton className="h-10 w-2/3 max-w-xl" />
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-40" />
      ))}
    </div>
  );
}
