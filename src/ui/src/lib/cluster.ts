/**
 * Cluster identity extraction shared by every page that surfaces
 * cluster-aware UI (Findings filter dropdown, FindingDetail breadcrumb /
 * sibling list, Dashboard top-clusters widget).
 *
 * Source of truth is the structured `evidence[0].note` payload that
 * clustered detectors embed:
 *
 *   - shared-db-write → `${entity}.${column}`
 *   - api-race        → `${METHOD} ${pathPattern}`
 *   - race-condition / mutation → `target` (e.g. `this.value`, `cache`)
 *
 * For duplicate-type / duplicate-function the detector titles quote the
 * shared name in single quotes (`'Foo' is defined N times`), so we fall
 * back to extracting that. Backticks are a last-resort fallback.
 *
 * Returns `null` for non-clustered detectors so filters / groupings
 * don't fill with per-finding noise (numeric literals, file paths,
 * console method names, …).
 */
export const CLUSTERED_DETECTORS: ReadonlySet<string> = new Set<string>([
  'duplicate-type',
  'duplicate-function',
  'api-race',
  'shared-db-write',
  'race-condition',
  'mutation',
  'same-name-evolution',
  'similar-functions',
]);

interface ClusterCandidate {
  detectorId: string;
  title: string;
  evidence?: { note?: string }[];
}

export function extractCluster(f: ClusterCandidate): string | null {
  if (!CLUSTERED_DETECTORS.has(f.detectorId)) return null;
  const note = f.evidence?.[0]?.note;
  if (note) {
    try {
      const meta = JSON.parse(note) as {
        method?: string;
        pathPattern?: string;
        entity?: string;
        column?: string;
        target?: string;
      };
      if (meta.method && meta.pathPattern) return `${meta.method} ${meta.pathPattern}`;
      if (meta.entity && meta.column) return `${meta.entity}.${meta.column}`;
      if (meta.target) return meta.target;
    } catch {
      // fall through
    }
  }
  const single = /'([^']+)'/.exec(f.title);
  if (single) return single[1] ?? null;
  const back = /`([^`]+)`/.exec(f.title);
  return back?.[1] ?? null;
}
