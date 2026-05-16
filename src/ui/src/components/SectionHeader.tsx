import type { ReactNode } from 'react';
import type { JSX } from 'react';

interface SectionHeaderProps {
  eyebrow: string;
  title: ReactNode;
  /** Right-aligned metadata (small mono). */
  meta?: ReactNode;
}

/**
 * Eyebrow caps + big serif sentence + right-aligned metadata. Shared
 * header pattern across every v2 page.
 */
export function SectionHeader({ eyebrow, title, meta }: SectionHeaderProps): JSX.Element {
  return (
    <header className="mb-6 sm:mb-8 flex flex-col sm:flex-row items-start sm:justify-between gap-3 sm:gap-6">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] sm:text-[11px] uppercase tracking-widest text-muted font-mono mb-2 sm:mb-3 truncate">
          {eyebrow}
        </div>
        <h1 className="font-serif text-[28px] sm:text-[36px] lg:text-[44px] leading-[1.1] text-ink tracking-tight">
          {title}
        </h1>
      </div>
      {meta && (
        <div className="text-[11px] sm:text-xs text-muted font-mono sm:text-right shrink-0 sm:pt-1">
          {meta}
        </div>
      )}
    </header>
  );
}
