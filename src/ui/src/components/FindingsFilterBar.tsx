import type { JSX } from 'react';
import { ChevronDown, Search } from 'lucide-react';

/**
 * Filter strip rendered above the Findings list. Owns nothing — every
 * piece of state is hoisted to the parent page so URL routing + reset
 * + pagination resets can stay in one place. Extracted out of
 * Findings.tsx to keep that page under the long-function detector
 * threshold + make the filter primitives reusable.
 */

export type Sev = 'high' | 'medium' | 'low';
export type SortKey = 'severity-cluster' | 'severity' | 'age' | 'detector';
export type FindingView = 'open' | 'false-positive';

interface FindingsFilterBarProps {
  sev: Set<Sev>;
  setSev: (s: Set<Sev>) => void;
  detectors: string[];
  detector: string;
  setDetector: (v: string) => void;
  directories: string[];
  directory: string;
  setDirectory: (v: string) => void;
  view: FindingView;
  setView: (v: FindingView) => void;
  query: string;
  setQuery: (v: string) => void;
}

export function FindingsFilterBar({
  sev,
  setSev,
  detectors,
  detector,
  setDetector,
  directories,
  directory,
  setDirectory,
  view,
  setView,
  query,
  setQuery,
}: FindingsFilterBarProps): JSX.Element {
  const toggle = (s: Sev) => {
    const next = new Set(sev);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSev(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 -mx-1 px-1">
      <SevToggle active={sev.has('high')} onClick={() => toggle('high')} severity="high" />
      <SevToggle active={sev.has('medium')} onClick={() => toggle('medium')} severity="medium" />
      <SevToggle active={sev.has('low')} onClick={() => toggle('low')} severity="low" />
      <Dropdown label="detector" value={detector} options={detectors} onChange={setDetector} />
      <Dropdown label="directory" value={directory} options={directories} onChange={setDirectory} />
      <Dropdown
        label="status"
        value={view}
        options={['open', 'false-positive']}
        onChange={(v) => setView(v as FindingView)}
      />
      <div className="flex-1 min-w-[200px] relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by title, path or fingerprint…"
          className="w-full rounded-md border border-border bg-panel pl-9 pr-3 py-1.5 text-xs text-ink font-mono placeholder-muted focus:border-accent focus:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={() => {
          setSev(new Set(['high', 'medium', 'low']));
          setDetector('any');
          setDirectory('any');
          setQuery('');
        }}
        className="text-xs text-muted hover:text-ink"
      >
        Reset
      </button>
    </div>
  );
}

function SevToggle({
  active,
  onClick,
  severity,
}: {
  active: boolean;
  onClick: () => void;
  severity: Sev;
}): JSX.Element {
  const cls = {
    high: active ? 'bg-high/15 border-high/60 text-high' : 'border-border text-muted',
    medium: active ? 'bg-med/15 border-med/60 text-med' : 'border-border text-muted',
    low: active ? 'bg-low/20 border-low/60 text-low' : 'border-border text-muted',
  }[severity];
  const label = severity === 'medium' ? 'MED' : severity.toUpperCase();
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-bold tracking-wider font-mono ' +
        cls
      }
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </button>
  );
}

interface DropdownProps {
  label: string;
  value: string;
  options: string[];
  onChange: ((v: string) => void) | (() => void);
}

function Dropdown({ label, value, options, onChange }: DropdownProps): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2 px-3 py-1 rounded-md border border-border bg-panel text-xs text-muted font-mono">
      {label}
      <select
        value={value}
        onChange={(e) => (onChange as (v: string) => void)(e.target.value)}
        className="bg-transparent text-ink focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-panel">
            {o}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="text-muted" />
    </label>
  );
}

export function SortDropdown({
  value,
  setValue,
}: {
  value: SortKey;
  setValue: (v: SortKey) => void;
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-1 cursor-pointer">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as SortKey)}
        className="bg-panel border border-border rounded-md px-2 py-1 text-xs text-ink font-mono focus:outline-none"
        aria-label="sort"
      >
        <option value="severity-cluster">severity, then cluster size</option>
        <option value="severity">severity</option>
        <option value="age">age</option>
        <option value="detector">detector</option>
      </select>
    </label>
  );
}

export function PageButton({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        'w-7 h-7 rounded text-xs font-mono ' +
        (active
          ? 'bg-ink text-panel'
          : disabled
            ? 'text-muted/40'
            : 'text-muted hover:text-ink hover:bg-bg')
      }
    >
      {children}
    </button>
  );
}
