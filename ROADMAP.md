# RotHunter — Roadmap

Detector ideas + improvements queued for future work. Each entry lists
the problem it catches, the deterministic signal, and the acceptance
criteria so the implementation has a clear bar.

## Planned detectors

### 1. `typescript-misuse` — TypeScript-as-JavaScript anti-patterns

A composite detector that flags code that nominally uses TypeScript but
deliberately throws away the type system. Splits into sub-rules so
operators can toggle individually or accept the bundle.

#### 1a. `any-leak` — `any` / `Promise<any>` / `unknown` cast escapes

**Signal**

- Function return type annotated `Promise<any>` / `any` / `Array<any>` /
  `Record<string, any>`.
- Variable declarations annotated `: any` outside `// @ts-expect-error`
  / `eslint-disable`-marked lines.
- `as any` / `as unknown as <T>` casts in non-test source.
- Generic parameters defaulting to `any` (`Map<string, any>`,
  `Record<K, any>`).

**Why it matters**
`any` opts out of every guarantee TS makes. One leak at an API boundary
spreads to every caller. `Promise<any>` is especially toxic — `.then`
chains silently accept any shape.

**Acceptance**

- Skip test files (`.test.ts` / `.spec.ts` / `__tests__/`).
- Skip generated files (`.generated.ts`, `*.d.ts`).
- Severity: `medium` per occurrence, cap 10 per file.
- Confidence: 0.9 (regex-based on type annotations, post-mask of
  strings/comments to avoid false hits in template literals).

#### 1b. `god-type` — wide type read narrowly by many callers

**Signal**

- An `interface` or `type` declaration with ≥ 8 fields where ≥ 50 % are
  marked `?` (optional).
- Used as a parameter type by ≥ 5 functions across ≥ 2 files.
- Each consumer reads only a small slice (≤ 3 fields) of the type.

**Why it matters**
A bag-of-options type that callers each treat as a different concept
hides API drift. Adding a field is invisible to old callers; renaming
one breaks everyone silently. The right shape is usually 2–3 small,
focused types named after each actual use case.

**Acceptance**

- Compute per-function field-access set via ts-morph property-access on
  the parameter binding.
- Cluster consumers by accessed-field signature; if ≥ 3 distinct
  signatures exist on the same type, emit a finding listing each
  signature + caller list.
- Severity: `medium` when ≥ 5 consumers, `high` when ≥ 12.
- Confidence: 0.8.
- LLM confirmer: optional — asks "are these callers conceptually the
  same operation on the same entity?" to filter cases where the wide
  type is the intentional database row shape consumed by genuinely
  related code.

#### 1c. `everything-optional` — type whose every field is `?`

**Signal**

- `interface` / `type` declaration where every field is optional and the
  type has ≥ 4 fields.
- Used in a position that does not exit the module (private helper) OR
  as a function parameter type (= the type IS the function's option
  bag).

**Why it matters**
`{ a?: string; b?: string; c?: string; ... }` defers every contract
decision to runtime. Functions taking such a type usually need
discriminated unions, builder methods, or explicit "required" + "options"
split.

**Acceptance**

- Trivial declarations (`{ value?: T }`) excluded — require ≥ 4 fields.
- React component props excluded when the type ends in `Props` AND the
  function body is a JSX-returning component (idiomatic React shape).
- Severity: `low`.
- Confidence: 0.85.

#### 1d. `wide-string-type` — `string` parameter that should be a union

**Signal**

- Function parameter typed `string` where ≥ 3 call sites pass the same
  literal subset (e.g. `'create' | 'update' | 'delete'`).
- The function body branches on the parameter via `switch` / `if` chain
  comparing to string literals.

**Why it matters**
`string` accepts every string. The compiler can't catch typos in caller
literals or refactors that miss one branch. A literal union or `const`
object turns the same code into a closed enumeration.

**Acceptance**

- Detect literal switch/if chains that compare the parameter against
  ≥ 3 string literals.
- Suggest the literal union derived from the observed values.
- Severity: `low`.
- Confidence: 0.8.

#### 1e. `boolean-trap` — multiple boolean params on the same function

**Signal**

- Function signature with ≥ 2 boolean parameters (`async`,
  `dryRun`, …) AND at least one call site passing positional booleans
  (`f(true, false)`).

**Why it matters**
`f(true, false)` is unreadable at the call site. The fix is either an
options object or splitting into two functions.

**Acceptance**

- Skip when boolean params have default values AND every call site uses
  named property syntax (`{ async: true }`).
- Severity: `low`.

---

## Implementation order suggestion

1. `any-leak` — pure regex pass over the source text post-comment-mask.
   Fastest to ship, highest signal, no graph work.
2. `everything-optional` — interface-level scan, no caller analysis.
3. `god-type` — needs caller-side property-access slicing. Heaviest of
   the bundle; ship after the other two have validated the format.
4. `wide-string-type` — needs literal-comparison scan inside function
   bodies. Moderate complexity.
5. `boolean-trap` — signature scan + caller analysis. Smallest but
   noisiest; ship behind a settings toggle defaulting to off.

## Other queued ideas

- **`hot-hub-file` enrichment** (already in repo as inline TODO):
  threshold scaling, severity tiers, barrel-export detection, multi-
  workspace blast-radius weighting.
- **Race-condition `getStartPos` ordering** — replace line-number
  ordering with numeric source offset for robustness on multi-statement
  lines (currently covered by CFG reachability; this is a belt-and-
  braces refinement).
- **Per-detector LLM cost UI** — backend already exposes `byDetector`
  in `/api/scans/:id/llm-stats`; History page only shows aggregate
  p50/p95. A table view + drill-down page would close the loop.
