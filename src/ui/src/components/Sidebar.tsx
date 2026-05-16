import type { JSX } from 'react';
import type { Route } from '../lib/route.js';
import { LogoMark } from './Logo.js';
import {
  LayoutDashboard,
  ListChecks,
  Network,
  History,
  Settings,
  type LucideIcon,
} from 'lucide-react';

interface SidebarProps {
  route: Route;
  onNavigate: (r: Route) => void;
}

interface NavItem {
  id: 'dashboard' | 'findings' | 'symbols' | 'history' | 'settings';
  label: string;
  icon: LucideIcon;
  to: Route;
  matches: (r: Route) => boolean;
}

const NAV: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    to: { name: 'dashboard' },
    matches: (r) => r.name === 'dashboard' || r.name === 'running',
  },
  {
    id: 'findings',
    label: 'Findings',
    icon: ListChecks,
    to: { name: 'findings' },
    matches: (r) => r.name === 'findings' || r.name === 'finding',
  },
  {
    id: 'symbols',
    label: 'Symbol graph',
    icon: Network,
    to: { name: 'symbols' },
    matches: (r) => r.name === 'symbols',
  },
  {
    id: 'history',
    label: 'Scan history',
    icon: History,
    to: { name: 'history' },
    matches: (r) => r.name === 'history',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    to: { name: 'settings' },
    matches: (r) => r.name === 'settings',
  },
];

export function Sidebar({ route, onNavigate }: SidebarProps): JSX.Element {
  return (
    <aside className="w-14 bg-panel border-r border-border flex flex-col items-center py-4 gap-2 shrink-0">
      <button
        type="button"
        onClick={() => onNavigate({ name: 'dashboard' })}
        className="mb-4"
        title="RotHunter"
      >
        <LogoMark size={36} />
      </button>
      {NAV.map((n) => {
        const Icon = n.icon;
        const active = n.matches(route);
        return (
          <button
            key={n.id}
            title={n.label}
            type="button"
            onClick={() => onNavigate(n.to)}
            className={
              'w-9 h-9 rounded-md flex items-center justify-center transition-colors ' +
              (active
                ? 'bg-accent/15 text-accent border border-accent/40'
                : 'text-muted hover:text-ink hover:bg-bg')
            }
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        );
      })}
    </aside>
  );
}
