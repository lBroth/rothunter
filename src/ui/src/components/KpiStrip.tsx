interface KpiCellProps {
  label: string;
  value: string | number;
  delta?: number;
  tone?: 'ink' | 'high' | 'med' | 'low' | 'accent';
  suffix?: string;
}

/**
 * Single counter cell: tiny tracking-wide caps label, big mono value,
 * optional delta arrow + magnitude beside.
 */
export function KpiCell({ label, value, delta, tone = 'ink', suffix }: KpiCellProps): JSX.Element {
  const toneClass = {
    ink: 'text-ink',
    high: 'text-high',
    med: 'text-med',
    low: 'text-low',
    accent: 'text-accent',
  }[tone];
  return (
    <div className="px-4 sm:px-5 py-3 sm:py-4">
      <div className="text-[9px] sm:text-[10px] uppercase tracking-widest text-muted font-mono mb-1.5 sm:mb-2">
        {label}
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`font-serif text-[28px] sm:text-[36px] leading-none tabular-nums ${toneClass}`}>
          {value}
        </span>
        {suffix && <span className="text-xs font-mono text-muted">{suffix}</span>}
        {delta != null && delta !== 0 && (
          <span
            className={
              'text-[11px] font-mono tabular-nums ' +
              (delta > 0 ? 'text-high' : 'text-low')
            }
          >
            {delta > 0 ? '↑' : '↓'}
            {Math.abs(delta)}
          </span>
        )}
        {delta === 0 && (
          <span className="text-[11px] font-mono text-muted">— 0</span>
        )}
      </div>
    </div>
  );
}

interface KpiStripProps {
  children: React.ReactNode;
}

/**
 * Horizontal divider-separated row of KPI cells inside a single
 * bordered card. Matches the design PDF's hero strip.
 */
export function KpiStrip({ children }: KpiStripProps): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-panel grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-y sm:divide-y-0 divide-border-soft">
      {children}
    </div>
  );
}
