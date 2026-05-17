import type { LucideIcon } from 'lucide-react';
import { Construction } from 'lucide-react';

interface PlaceholderProps {
  title: string;
  subtitle?: string;
  phase: string;
  icon?: LucideIcon;
}

/**
 * Used for the routes whose page hasn't been built yet (Findings list,
 * Symbol graph, Scan history, Settings). Keeps the UI shell navigable
 * without forcing each tab to fall back to the dashboard.
 */
export function Placeholder({
  title,
  subtitle,
  phase,
  icon: Icon = Construction,
}: PlaceholderProps): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto py-24 text-center">
      <Icon size={48} strokeWidth={1.5} className="mx-auto text-muted mb-6" />
      <div className="text-[11px] uppercase tracking-widest text-muted font-mono mb-2">
        {phase}
      </div>
      <h1 className="font-serif text-3xl text-ink mb-3">{title}</h1>
      {subtitle && <p className="text-muted">{subtitle}</p>}
    </div>
  );
}
