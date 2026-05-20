/**
 * Single-source route union for the entire UI. Every nav action is just a
 * `setRoute(...)` call at the App level.
 */
export type Route =
  | { name: 'dashboard' }
  | {
      name: 'findings';
      scanId?: string;
      detector?: string;
      directory?: string;
      severity?: 'high' | 'medium' | 'low';
      view?: 'open' | 'false-positive';
      layer?: 3;
    }
  | { name: 'finding'; fingerprint: string }
  | { name: 'running'; scanId: string }
  | { name: 'history' }
  | { name: 'symbols'; path?: string }
  | { name: 'settings' };
