import type { Project } from 'ts-morph';
import type { SymbolRecord } from '../types.js';
import type { ImportRecord } from '../graph/import-graph.js';

/**
 * Shared input shape for file-walking detectors. Eleven detectors used
 * to declare their own near-identical `{ workspaceRoot, files, project? }`
 * interface — the duplicate-type detector flagged them as a cluster.
 * One canonical type here, each detector either uses this directly or
 * extends it with detector-specific fields.
 */
export interface FileWalkingDetectorInput {
  workspaceRoot: string;
  files: ReadonlyArray<string>;
  /**
   * Optional pre-built ts-morph Project — the orchestrator builds one
   * shared Project per scan and passes it down so detectors don't have
   * to re-parse the same source tree N times. When absent, detectors
   * fall back to readFileSync via `utils/source-reader.ts`.
   */
  project?: Project;
}

/**
 * Detectors whose input is the parsed symbol set (no per-file walking).
 * Used by long-function / deep-nesting / public-any / hot-hub-file.
 */
export interface SymbolDetectorInput {
  symbols: ReadonlyArray<SymbolRecord>;
}

/**
 * Detectors that consume the import graph directly (dead-export,
 * dead-api, dead-handler, unused-deps). Shape kept here so changes to
 * the import record propagate via a single canonical reference.
 */
export interface ImportGraphDetectorInput {
  imports: ReadonlyArray<ImportRecord>;
}
