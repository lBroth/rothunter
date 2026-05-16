/**
 * Race-condition golden fixtures.
 *
 * Each exported symbol is a race-detector candidate. The associated golden
 * verdict (real race vs safe) lives in `race-golden.ts` and is matched by
 * the `enclosingName` field surfaced on the finding. The eval harness
 * scans this file, runs the deterministic race-condition detector, then
 * runs the LLM confirmer on each finding to compare against the
 * expected verdict.
 *
 * DO NOT IMPORT FROM PRODUCTION CODE.
 *
 * Naming convention:
 *   - real_*  — genuine race; LLM should say `race`
 *   - safe_*  — false positive candidate; LLM should say `safe`
 */

declare const flush: (item?: unknown) => Promise<void>;
declare const fetchUser: (id: string) => Promise<{ name: string; tags: string[] }>;
declare const emitter: { on(event: string, fn: (...args: unknown[]) => unknown): void };
declare const acquire: () => Promise<{ release(): void }>;

// ---------------------------------------------------------------------------
// TRUE POSITIVES — genuine races
// ---------------------------------------------------------------------------

/**
 * Classic lost-update: read `this.tally`, yield, write back. Two concurrent
 * callers can both stale-read and stomp each other's increment.
 */
export class TallyCounter {
  private tally = 0;
  async real_tally_increment(): Promise<void> {
    const cur = this.tally;
    await flush();
    this.tally = cur + 1;
  }
}

/**
 * Module-scope mutable cache filled across an `await`. Two parallel callers
 * with the same id both miss, both fetch, both write — second write wins
 * and the first fetch's work is thrown away.
 */
let userCache: Record<string, { name: string; tags: string[] }> = {};
export async function real_cache_fill(id: string): Promise<{ name: string; tags: string[] }> {
  const existing = userCache[id];
  if (existing) return existing;
  const fetched = await fetchUser(id);
  userCache = { ...userCache, [id]: fetched };
  return fetched;
}

/**
 * Promise.all-map writing a counter on `this`. The callback is invoked
 * once per element with full parallelism — every read-modify-write on
 * `this.processed` races against every other invocation.
 */
export class ParallelProcessor {
  private processed = 0;
  async real_parallel_map(items: number[]): Promise<void> {
    await Promise.all(items.map(async (item) => {
      const cur = this.processed;
      await flush(item);
      this.processed = cur + 1;
    }));
  }
}

/**
 * Event-emitter handler closing over a module-scope buffer. Each event
 * fires the async handler; both can read the same buffer before either
 * writes back.
 */
let eventBuffer: number[] = [];
export function real_emitter_buffer(): void {
  emitter.on('data', async (...args: unknown[]) => {
    const item = args[0] as number;
    const cur = eventBuffer;
    await flush(item);
    eventBuffer = [...cur, item];
  });
}

/**
 * Sibling `Promise.all` arms both touching `this.acc` — guaranteed
 * lost-update even without timing windows.
 */
export class Sibling {
  private acc = 0;
  async real_sibling_arms(): Promise<void> {
    await Promise.all([
      (async () => { this.acc = this.acc + 1; })(),
      (async () => { this.acc = this.acc + 2; })(),
    ]);
  }
}

// ---------------------------------------------------------------------------
// FALSE POSITIVES — code that looks racy but is safe
// ---------------------------------------------------------------------------

/**
 * Per-request scoped state. The `state` object is local to this call —
 * not shared between callers. The detector flags it because the deterministic
 * layer cannot tell scoped-let from module-let; the LLM should see the
 * `let` declared inside the function body and clear it.
 */
export async function safe_per_request_scoped(id: string): Promise<number> {
  let state = 0;
  const cur = state;
  await flush(id);
  state = cur + 1;
  return state;
}

/**
 * Idempotent assignment of a constant. Even with concurrent callers, every
 * invocation writes the same value, so there is no information loss.
 */
export class ReadyFlag {
  private ready = false;
  async safe_idempotent_set(): Promise<void> {
    await flush();
    this.ready = true;
  }
}

/**
 * Mutex-wrapped critical section. The `await acquire()` returns a lock
 * handle whose `release()` is called after the write. Callers are
 * serialised at the mutex — concurrent invocations cannot both be inside
 * the critical region.
 */
export class GuardedCounter {
  private value = 0;
  async safe_mutex_wrapped(): Promise<void> {
    const lock = await acquire();
    try {
      const cur = this.value;
      await flush();
      this.value = cur + 1;
    } finally {
      lock.release();
    }
  }
}

/**
 * Cache write where the read and write target differ. The read is `this.raw`
 * but the write is `this.parsed` — no lost-update because the two
 * derived values are independent.
 */
export class TwoFields {
  private raw = '';
  private parsed: unknown = null;
  async safe_distinct_targets(): Promise<void> {
    const r = this.raw;
    await flush();
    this.parsed = JSON.parse(r);
  }
}

/**
 * `Promise.all(.map(async))` where the callback only reads shared state —
 * no write back. Detector should not flag this; if it does, the LLM should
 * clear it.
 */
export class ReadOnlyMap {
  private base = 10;
  async safe_map_read_only(ids: string[]): Promise<number[]> {
    return Promise.all(ids.map(async (id) => {
      await flush(id);
      return this.base;
    }));
  }
}

/**
 * `Promise.all` with two arms, each writing a DIFFERENT target on `this`.
 * Detector correctly does not flag, but included as a control case.
 */
export class DistinctTargets {
  private a = 0;
  private b = 0;
  async safe_distinct_arms(): Promise<void> {
    await Promise.all([
      (async () => { this.a = 1; })(),
      (async () => { this.b = 2; })(),
    ]);
  }
}

/**
 * Single-flight pattern: the function name is `loadOnce`, the write is
 * guarded by an `if (this.value !== null) return this.value` check
 * before the await. Concurrent callers all return the first one's result
 * after the first await settles. The LLM should recognise the guard and
 * clear the finding.
 */
export class SingleFlight {
  private value: number | null = null;
  async safe_single_flight_loadOnce(): Promise<number> {
    if (this.value !== null) return this.value;
    await flush();
    this.value = 42;
    return this.value;
  }
}
