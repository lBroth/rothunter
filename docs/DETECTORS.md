# Detector reference

24 detectors out of the box. Severity is the default emit tier; the
LLM verdict can adjust it (real defect → keep, intentional pattern →
auto-FP at confidence ≥ `llmAutoFpThreshold`, see Settings → LLM).
Tunables are listed for the detectors that read them; the rest run
on fixed heuristics.

## Always-on (symbol / graph only — single & multi-workspace)

| Id                         | Severity | Flags                                                                                                                                                                            | Tunables                     |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `duplicate-type`           | medium   | Two type / interface declarations with structurally equivalent shapes across files. LLM confirms "same domain concept" or rejects on coincidental shape (e.g. `{x,y}`).          | —                            |
| `duplicate-function`       | medium   | Two function bodies sharing a strict or near-duplicate skeleton (≥ 0.65 Jaccard on 4-token shingles).                                                                            | —                            |
| `dead-module`              | low      | A file with no inbound imports + not an entry point. Honours `package.json#main/module/exports/bin/scripts`, framework conventions (Next, Sveltekit, …) and IaC handler strings. | —                            |
| `dead-export`              | low      | An exported symbol no other workspace file imports. Backed off by type-surface reachability (interface used as sibling signature) + published-library mode.                      | —                            |
| `dead-api` (multi-ws only) | low      | An exported symbol no SIBLING workspace imports — flags the cross-repo "should be internal" case.                                                                                | —                            |
| `long-function`            | low      | Function whose body exceeds the line threshold.                                                                                                                                  | `MAX_LINES` (default 60)     |
| `deep-nesting`             | low      | Block nested deeper than the threshold.                                                                                                                                          | `MAX_DEPTH` (default 4)      |
| `public-any`               | medium   | Exported function or class member typed `any` (return, param, property).                                                                                                         | —                            |
| `hot-hub-file`             | low      | A file imported by ≥ N other files — a refactor "blast radius" sink.                                                                                                             | `HUB_THRESHOLD` (default 15) |

## Single-workspace (file walking / Project / git)

| Id                  | Severity | Flags                                                                                                                                             | Tunables                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `dead-handler`      | low      | Lambda / Netlify / Serverless framework handler file with no wiring.                                                                              | —                                     |
| `mutation`          | medium   | Parameter mutated in-place or escaping out of the function. LLM verdict catches accumulator patterns.                                             | —                                     |
| `race-condition`    | high     | Read-modify-write across an `await` boundary on a shared resource. CFG-aware. LLM verdict required.                                               | —                                     |
| `shared-db-write`   | high     | ≥ 2 call sites writing the same DB column (Prisma / Drizzle / Sequelize / TypeORM / Mongoose / Knex / raw SQL). Cross-workspace in monorepo mode. | —                                     |
| `api-race`          | high     | ≥ 2 client call sites hitting the same write endpoint (PUT / PATCH / POST) without coordination. Cross-workspace in monorepo mode.                | —                                     |
| `bad-config`        | medium   | TSConfig / ESLint / Biome anti-pattern: `strict: false`, `noImplicitAny: false`, missing extends, etc.                                            | —                                     |
| `silent-catch`      | medium   | `catch` block that swallows the error (empty body, return null, console-only). Skips bodies with intent comments.                                 | —                                     |
| `skip-tests`        | medium   | `.skip` / `.only` left in a committed test.                                                                                                       | —                                     |
| `long-file`         | low      | File above the LOC threshold (excluding pure-comment lines).                                                                                      | `MAX_LINES` (default 500)             |
| `console-log-prod`  | low      | `console.log` / `.debug` / `.info` outside test or dev paths.                                                                                     | —                                     |
| `magic-numbers`     | low      | Numeric literal outside the whitelist + outside regex / const / object-key positions.                                                             | `whitelist`, `perFileCap` (default 5) |
| `mutable-globals`   | medium   | Module-level `let` / `var` reassigned post-init.                                                                                                  | —                                     |
| `unused-deps`       | low      | `package.json` dependency not referenced from `src/`.                                                                                             | —                                     |
| `similar-functions` | low      | Fuzzy cluster of near-duplicate function bodies + canonical-pick suggestion.                                                                      | —                                     |
| `todo-comments`     | low      | `TODO` / `FIXME` / `HACK` / `XXX` marker comment. Skips explanatory `NOTE` blocks via LLM triage.                                                 | —                                     |

## Suppressing a real false positive

When a finding is intentional design, prefer the in-source pragma —
it stays with the code and survives every rescan:

```ts
// rothunter:ignore-<detectorId>
// reason: <one-line explanation>
const x = someUsuallyForbiddenPattern();
```

Replace `<detectorId>` with the literal id from the column above
(e.g. `silent-catch`, `mutation`, `magic-numbers`). Both lines are
required. `// rothunter:ignore-all` silences every detector for that
line.

Alternative: click **Mark false positive** in the dashboard. That
adds the fingerprint to `.rothunter/false-positives.json`; commit
the file to share the decision with the team.
