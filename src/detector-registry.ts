/**
 * Single source of truth for detector IDs.
 *
 * Anything that lists every detector (the server's settings UI, the CLI
 * `--detectors` flag validation, future detector documentation) imports
 * from here. Previously the server/index.ts hardcoded a parallel list
 * that drifted when new detectors were wired into rothunter.ts.
 *
 * To register a new detector:
 *   1. Add its id below.
 *   2. Import + invoke it from rothunter.ts.
 *   3. (Optional) Tag it as `singleWorkspaceOnly` if it can't run when
 *      multi-workspace-scanner is active — see the `MULTI_WORKSPACE_*`
 *      sets below for the current split.
 */

export const DETECTOR_IDS = [
  // Always-on (symbol/graph-only)
  'duplicate-type',
  'duplicate-function',
  'dead-module',
  'dead-export',
  'dead-api',
  'long-function',
  'deep-nesting',
  'public-any',
  'hot-hub-file',
  're-export-shadow',
  // Single-workspace only (file-walking, git, or ts-morph Project-bound)
  'dead-handler',
  'mutation',
  'race-condition',
  'shared-db-write',
  'api-race',
  'bad-config',
  'silent-catch',
  'skip-tests',
  'long-file',
  'console-log-prod',
  'magic-numbers',
  'mutable-globals',
  'unused-deps',
  'similar-functions',
  'todo-comments',
] as const;

export type DetectorId = (typeof DETECTOR_IDS)[number];

/**
 * Detectors that need real workspace-root-relative file paths or git
 * access on a single workspace. Multi-workspace mode skips these because
 * multi-workspace-scanner prefixes paths with the workspace name (see
 * the warn-log in rothunter.ts run()).
 */
export const MULTI_WORKSPACE_SKIPPED = new Set<DetectorId>([
  'dead-handler',
  'mutation',
  'race-condition',
  'shared-db-write',
  'api-race',
  'bad-config',
  'silent-catch',
  'skip-tests',
  'long-file',
  'console-log-prod',
  'magic-numbers',
  'mutable-globals',
  'unused-deps',
  'similar-functions',
  'todo-comments',
]);

/**
 * Cross-repo detector: only runs in multi-workspace mode (its whole
 * purpose is to flag exported symbols that nobody imports across
 * workspace boundaries — in single-workspace mode dead-export already
 * covers that ground).
 */
export const MULTI_WORKSPACE_ONLY = new Set<DetectorId>(['dead-api']);
