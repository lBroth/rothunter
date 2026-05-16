import type { JSX } from 'react';
/**
 * Shared chip primitives used across the dashboard, findings list,
 * finding detail, and verdict stream.
 */

interface SeverityChipProps {
  severity: 'high' | 'medium' | 'low';
  withDot?: boolean;
}

export function SeverityChip({ severity, withDot = true }: SeverityChipProps): JSX.Element {
  const cls = {
    high: 'bg-high/15 border-high/60 text-high',
    medium: 'bg-med/15 border-med/60 text-med',
    low: 'bg-low/20 border-low/60 text-low',
  }[severity];
  const label = severity === 'medium' ? 'MED' : severity.toUpperCase();
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wider font-mono ${cls}`}
    >
      {withDot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}

interface ClusterPillProps {
  name: string;
  /** Truncate after N chars (default 24). */
  max?: number;
}

export function ClusterPill({ name, max = 24 }: ClusterPillProps): JSX.Element {
  const display = name.length > max ? name.slice(0, max - 1) + '…' : name;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-info/15 border border-info/40 text-info font-mono text-[10px] whitespace-nowrap">
      §{display}
    </span>
  );
}

export function MetaCode({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <code className="font-mono text-[11px] text-muted bg-bg px-1 py-px rounded-sm">{children}</code>
  );
}
