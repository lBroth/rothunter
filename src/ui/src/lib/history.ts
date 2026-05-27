// SPA route ↔ URL binding. Non-/api/* paths fall through to index.html
// (Vite in dev, @fastify/static in prod).
import { useEffect, useState } from 'react';
import type { Route } from './route.js';

const PATHS = {
  dashboard: '/',
  findings: '/findings',
  history: '/history',
  symbols: '/symbols',
  settings: '/settings',
} as const;

export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'dashboard':
      return PATHS.dashboard;
    case 'findings': {
      const base = route.scanId
        ? `/scan/${encodeURIComponent(route.scanId)}/findings`
        : PATHS.findings;
      const qs = new URLSearchParams();
      if (route.detector) qs.set('detector', route.detector);
      if (route.directory) qs.set('directory', route.directory);
      if (route.severity) qs.set('severity', route.severity);
      if (route.view) qs.set('view', route.view);
      if (route.layer) qs.set('layer', String(route.layer));
      return qs.toString() ? `${base}?${qs}` : base;
    }
    case 'finding':
      return `/finding/${encodeURIComponent(route.fingerprint)}`;
    case 'running':
      return `/scan/${encodeURIComponent(route.scanId)}`;
    case 'history':
      return PATHS.history;
    case 'symbols':
      return route.path
        ? `/symbols/${route.path.split('/').map(encodeURIComponent).join('/')}`
        : PATHS.symbols;
    case 'settings':
      return PATHS.settings;
  }
}

export function pathToRoute(path: string): Route {
  const qIdx = path.indexOf('?');
  const search = qIdx >= 0 ? path.slice(qIdx + 1) : '';
  const bare = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const params = new URLSearchParams(search);
  const detector = params.get('detector') ?? undefined;
  const directory = params.get('directory') ?? undefined;
  const sev = params.get('severity');
  const severity = sev === 'high' || sev === 'medium' || sev === 'low' ? sev : undefined;
  const v = params.get('view');
  const view = v === 'open' || v === 'false-positive' ? v : undefined;
  const layerRaw = params.get('layer');
  const layer = layerRaw === '3' ? (3 as const) : undefined;
  path = bare;
  if (path === '/' || path === '') return { name: 'dashboard' };
  if (path === PATHS.findings)
    return { name: 'findings', detector, directory, severity, view, layer };
  if (path === PATHS.history) return { name: 'history' };
  if (path === PATHS.settings) return { name: 'settings' };
  if (path.startsWith('/symbols')) {
    const rest = path.slice('/symbols'.length).replace(/^\//, '');
    return { name: 'symbols', path: rest || undefined };
  }
  const finding = /^\/finding\/(.+)$/.exec(path);
  if (finding) return { name: 'finding', fingerprint: decodeURIComponent(finding[1]!) };
  const scanFindings = /^\/scan\/([^/]+)\/findings$/.exec(path);
  if (scanFindings)
    return {
      name: 'findings',
      scanId: decodeURIComponent(scanFindings[1]!),
      detector,
      directory,
      severity,
      view,
      layer,
    };
  const running = /^\/scan\/(.+)$/.exec(path);
  if (running) return { name: 'running', scanId: decodeURIComponent(running[1]!) };
  return { name: 'dashboard' };
}

/**
 * Stateful route hook. Reads the initial route from `window.location.pathname`,
 * pushes a new history entry whenever the consumer calls `setRoute`, and
 * follows browser back / forward via `popstate`.
 */
export function useHistoryRoute(): { route: Route; setRoute: (r: Route) => void } {
  const [route, setRouteState] = useState<Route>(() =>
    typeof window === 'undefined'
      ? { name: 'dashboard' }
      : pathToRoute(window.location.pathname + window.location.search),
  );

  useEffect(() => {
    function onPop(): void {
      setRouteState(pathToRoute(window.location.pathname + window.location.search));
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setRoute = (next: Route): void => {
    const path = routeToPath(next);
    if (path !== window.location.pathname + window.location.search) {
      window.history.pushState(null, '', path);
    }
    setRouteState(next);
  };

  return { route, setRoute };
}
