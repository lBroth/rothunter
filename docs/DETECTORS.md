# Detector reference

32 detectors out of the box. **22 ship ON by default** — every one
targets cross-file / data-flow / contract drift that single-file
linters can't reach. **10 ship OFF by default** — each one duplicates
a standard ESLint rule (or plugin); flip them ON from the Settings UI
if your project doesn't enable the equivalent.

Severity is the default emit tier; the LLM verdict can adjust it
(real defect → keep, intentional pattern → auto-FP at confidence ≥
`llmAutoFpThreshold`, see Settings → LLM). Tunables are listed for
the detectors that read them; the rest run on fixed heuristics.

## Default ON — hard spots lint and tsc miss

### Cross-file reachability (symbol / import graph)

| Id                         | Severity | Flags                                                                                                                                                                            | Tunables                     |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `dead-module`              | low      | A file with no inbound imports + not an entry point. Honours `package.json#main/module/exports/bin/scripts`, framework conventions (Next, Sveltekit, …) and IaC handler strings. | —                            |
| `dead-export`              | low      | An exported symbol no other workspace file imports. Backed off by type-surface reachability (interface used as sibling signature) + published-library mode.                      | —                            |
| `dead-api` (multi-ws only) | low      | An exported symbol no SIBLING workspace imports — flags the cross-repo "should be internal" case.                                                                                | —                            |
| `dead-handler`             | low      | Lambda / Netlify / Serverless framework handler file with no wiring.                                                                                                             | —                            |
| `hot-hub-file`             | low      | A file imported by ≥ N other files — a refactor "blast radius" sink.                                                                                                             | `HUB_THRESHOLD` (default 15) |

### Concurrency / data-flow

| Id                | Severity | Flags                                                                                                                                             | Tunables |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `race-condition`  | high     | Read-modify-write across an `await` boundary on a shared resource. CFG-aware. LLM verdict required.                                               | —        |
| `api-race`        | high     | ≥ 2 client call sites hitting the same write endpoint (PUT / PATCH / POST) without coordination. Cross-workspace in monorepo mode.                | —        |
| `shared-db-write` | high     | ≥ 2 call sites writing the same DB column (Prisma / Drizzle / Sequelize / TypeORM / Mongoose / Knex / raw SQL). Cross-workspace in monorepo mode. | —        |
| `mutation`        | medium   | Parameter mutated in-place or escaping out of the function. LLM verdict catches accumulator patterns.                                             | —        |

### AST / type clustering

| Id                        | Severity | Flags                                                                                                                                                                   | Tunables                                                        |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `duplicate-type`          | medium   | Two type / interface declarations with structurally equivalent shapes across files. LLM confirms "same domain concept" or rejects on coincidental shape (e.g. `{x,y}`). | —                                                               |
| `duplicate-function`      | medium   | Two function bodies sharing a strict or near-duplicate skeleton (≥ 0.65 Jaccard on 4-token shingles).                                                                   | —                                                               |
| `similar-functions`       | low      | Fuzzy cluster of near-duplicate function bodies + canonical-pick suggestion.                                                                                            | —                                                               |
| `schema-shape-divergence` | medium   | Two exported types whose names share a common stem (`User` vs `UserDTO`) and whose field sets diverge by 1-2 keys — the classic model/DTO drift.                        | `maxDriftFields` (default 2), `minSharedFraction` (default 0.5) |

### Package / config contract

| Id                        | Severity     | Flags                                                                                                                                                                                                 | Tunables |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `bad-config`              | medium       | TSConfig / ESLint / Biome anti-pattern: `strict: false`, `noImplicitAny: false`, missing extends, etc.                                                                                                | —        |
| `package-export-mismatch` | high         | `package.json` `main` / `module` / `types` / `bin` / `exports` paths that point at files missing on disk and without a TS source counterpart. Skips wildcard subpaths and `"private": true` packages. | —        |
| `env-var-undeclared`      | medium / low | `process.env.X` / `import.meta.env.X` reads not declared in any `.env.example` / Dockerfile `ENV` / docker-compose `environment:`. Paired LOW finding for the inverse — vars declared but never read. | —        |
| `unused-deps`             | low          | `package.json` dependency not referenced from `src/`.                                                                                                                                                 | —        |
| `mutable-globals`         | medium       | Module-level `let` / `var` reassigned post-init. No ESLint rule targets this exact shape — `prefer-const` flags the opposite case, `no-var` only the keyword.                                         | —        |

### Barrel / re-export drift

| Id                          | Severity      | Flags                                                                                                                                                                                         | Tunables |
| --------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `re-export-shadow`          | medium / high | A barrel re-exports the same name from two different modules, or a re-export shadows a sibling local declaration (HIGH). Alias-aware — `export { Foo as FooLegacy }` disambiguates correctly. | —        |
| `default-export-name-drift` | low           | A default export consumed under 2+ different local names across its importers (half-done rename refactors). Ranked by importer count.                                                         | —        |

### Cross-file flow

| Id                              | Severity | Flags                                                                                                                                                                                                                                               | Tunables |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `producer-consumer-field-drift` | high     | Express / Fastify route reads `req.body.X` / `req.query.X` / `req.params.X` for a key no fetch / axios callsite in the workspace ever sends to that URL. URL match on string literal (template-string prefix tolerated); endpoints keyed by METHOD. | —        |
| `unsanitized-input-to-sink`     | high     | Taint flow from request-shaped sources (`req.*`, `searchParams.get`, `formData.get`) to dangerous sinks: raw SQL, `child_process.exec` / `spawn`, fs path concatenation, `eval` / `new Function`, dynamic `import()`, tagged SQL templates.         | —        |

## Default OFF — covered by a standard ESLint rule

Flip these ON in Settings if your project doesn't run the equivalent
lint rule. Each ships OFF because running both produces duplicate
noise.

| Id                       | ESLint analog                                      | Severity | Flags                                                                                                                                        |
| ------------------------ | -------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-any`             | `@typescript-eslint/no-explicit-any`               | medium   | Exported function or class member typed `any` (return, param, property).                                                                     |
| `long-function`          | `max-lines-per-function`                           | low      | Function whose body exceeds the line threshold.                                                                                              |
| `long-file`              | `max-lines`                                        | low      | File above the LOC threshold (excluding pure-comment lines).                                                                                 |
| `deep-nesting`           | `max-depth` / `complexity`                         | low      | Block nested deeper than the threshold.                                                                                                      |
| `magic-numbers`          | `no-magic-numbers`                                 | low      | Numeric literal outside the whitelist + outside regex / const / object-key positions.                                                        |
| `console-log-prod`       | `no-console`                                       | low      | `console.log` / `.debug` / `.info` outside test or dev paths.                                                                                |
| `skip-tests`             | `jest/no-disabled-tests` + `jest/no-focused-tests` | medium   | `.skip` / `.only` left in a committed test.                                                                                                  |
| `silent-catch`           | `no-empty` (`allowEmptyCatch: false`)              | medium   | `catch` block that swallows the error (empty body, return null, console-only). Catches console-only / bare-return shapes `no-empty` doesn't. |
| `todo-comments`          | `no-warning-comments`                              | low      | `TODO` / `FIXME` / `HACK` / `XXX` marker comment. Walks polyglot trees (Python / Go / shell) the ESLint rule can't see.                      |
| `test-without-assertion` | `jest/expect-expect`                               | medium   | `it()` / `test()` body with no `expect` / `assert` / `should` / `.toThrow` / snapshot / sinon matcher / project helper.                      |

## Suppressing a real false positive

When a finding is intentional design, prefer the in-source pragma —
it stays with the code and survives every rescan:

```ts
// rothunter:ignore-<detectorId>
// reason: <one-line explanation>
const x = someUsuallyForbiddenPattern();
```

Replace `<detectorId>` with the literal id from any table above
(e.g. `silent-catch`, `unsanitized-input-to-sink`, `magic-numbers`).
Both lines are required. `// rothunter:ignore-all` silences every
detector for that line.

Alternative: click **Mark false positive** in the dashboard. That
adds the fingerprint to `.rothunter/false-positives.json`; commit
the file to share the decision with the team.
