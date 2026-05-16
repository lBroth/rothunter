/**
 * Golden ground-truth verdicts for the race-condition LLM confirmer.
 *
 * Each entry maps a finding (identified by its `enclosingName`) to the
 * expected LLM verdict. The eval harness scans
 * `race-fixtures.ts`, runs the deterministic race-condition detector,
 * matches each finding to a golden entry, and compares the LLM verdict.
 *
 * DO NOT IMPORT FROM PRODUCTION CODE.
 */

export interface RaceGolden {
  /** Short label for the eval table. */
  id: string;
  /** Function/method name surfaced as `enclosingName` on the finding. */
  enclosingName: string;
  /** Detection pattern, for the prompt + eval surface. */
  pattern: 'read-modify-write' | 'promise-all' | 'emitter-handler';
  /** Expected LLM verdict. */
  expected: 'race' | 'safe';
  /** Lower bound on |confidence| for a correct verdict to count. */
  min_confidence: number;
  /** Why this is the right verdict — for humans reading the eval report. */
  rationale: string;
}

export const RACE_GOLDEN: RaceGolden[] = [
  // --- True positives -------------------------------------------------------
  {
    id: 'real/tally-increment',
    enclosingName: 'real_tally_increment',
    pattern: 'read-modify-write',
    expected: 'race',
    min_confidence: 0.8,
    rationale: 'Classic read-modify-write across await on `this.tally`. No mutex, no idempotency.',
  },
  {
    id: 'real/cache-fill',
    enclosingName: 'real_cache_fill',
    pattern: 'read-modify-write',
    expected: 'race',
    min_confidence: 0.7,
    rationale: 'Module-scope cache fill across an await — duplicate fetches + last-write-wins.',
  },
  {
    id: 'real/parallel-map',
    enclosingName: 'real_parallel_map',
    pattern: 'promise-all',
    expected: 'race',
    min_confidence: 0.8,
    rationale: '`Promise.all(items.map(async ...))` callback writes `this.processed` across an await — every parallel invocation races.',
  },
  {
    id: 'real/emitter-buffer',
    enclosingName: 'real_emitter_buffer',
    pattern: 'emitter-handler',
    expected: 'race',
    min_confidence: 0.75,
    rationale: 'Emitter handler closes over module-scope `eventBuffer` with read-modify-write across await.',
  },
  {
    id: 'real/sibling-arms',
    enclosingName: 'real_sibling_arms',
    pattern: 'promise-all',
    expected: 'race',
    min_confidence: 0.85,
    rationale: 'Two parallel `Promise.all` arms both write `this.acc` — guaranteed lost-update.',
  },

  // --- False positives — LLM must clear -------------------------------------
  {
    id: 'safe/per-request-scoped',
    enclosingName: 'safe_per_request_scoped',
    pattern: 'read-modify-write',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: '`state` is a function-local `let` — every caller has its own copy. Not shared.',
  },
  {
    id: 'safe/idempotent-set',
    enclosingName: 'safe_idempotent_set',
    pattern: 'read-modify-write',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Every concurrent caller writes the same constant value — no information loss.',
  },
  {
    id: 'safe/mutex-wrapped',
    enclosingName: 'safe_mutex_wrapped',
    pattern: 'read-modify-write',
    expected: 'safe',
    min_confidence: 0.75,
    rationale: 'Section is wrapped in `await acquire()` / `lock.release()` — callers serialised at the mutex.',
  },
  {
    id: 'safe/distinct-targets',
    enclosingName: 'safe_distinct_targets',
    pattern: 'read-modify-write',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: 'Read target (`this.raw`) and write target (`this.parsed`) differ — no lost-update possible.',
  },
  {
    id: 'safe/map-read-only',
    enclosingName: 'safe_map_read_only',
    pattern: 'promise-all',
    expected: 'safe',
    min_confidence: 0.75,
    rationale: 'Map callback only reads `this.base`; never writes shared state.',
  },
  {
    id: 'safe/distinct-arms',
    enclosingName: 'safe_distinct_arms',
    pattern: 'promise-all',
    expected: 'safe',
    min_confidence: 0.75,
    rationale: 'Two parallel arms write `this.a` and `this.b` — different targets, no race.',
  },
  {
    id: 'safe/single-flight-loadOnce',
    enclosingName: 'safe_single_flight_loadOnce',
    pattern: 'read-modify-write',
    expected: 'safe',
    min_confidence: 0.7,
    rationale: '`if (this.value !== null) return this.value` guard before the await — second caller short-circuits.',
  },
];
