# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-rc.3] — 2026-05-28

### Added

- **Clone-free docker compose stack.** New file
  `src/docker/docker-compose.standalone.yml` pulls the pre-built
  `ghcr.io/lbroth/rothunter:latest` image instead of building from
  source. Operators can now boot the full engine + UI + llama.cpp
  sidecar with a single piped curl, no clone required:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/lBroth/rothunter/main/src/docker/docker-compose.standalone.yml \
    | ROTHUNTER_WORKSPACE_HOST=$(pwd) docker compose -f - up
  ```
  The original `docker-compose.yml` (which uses `build:` from source)
  stays as the developer flow — `npm run docker` continues to work
  unchanged. README + site landing updated.

## [1.1.0-rc.2] — 2026-05-28

### Added

- **`dead-endpoint` detector** (MED). HTTP route declared
  (`app.<method>('/url', …)` / Express / Fastify) with zero
  fetch / axios callsites anywhere in the workspace bucket. Best
  signal in monorepo mode where every linked service is in the scan
  — the detector spots every API endpoint whose remaining callers
  have all been removed, so the route can be safely deleted.
  Companion to `producer-consumer-field-drift`: that detector
  matches server-reads against client-writes for the same URL; this
  one fires when the match returns zero clients. Param-aware (a
  server route `/api/users/:id` matches template-string clients
  like `/api/users/${id}`); tolerates trailing-slash mismatches.
  Honours `// rothunter:ignore-dead-endpoint` for routes consumed
  by an unscanned external client. Ships ON by default.

## [1.1.0-rc.1] — 2026-05-28

### Added

#### 8 new detectors

| Id                              | Severity      | Catches                                                                                                                                                                       |
| ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `re-export-shadow`              | medium / high | A barrel re-exports the same name from two different modules, or shadows a sibling local declaration                                                                          |
| `default-export-name-drift`     | low           | A default export is imported under 2+ different local names across the workspace (half-done rename refactors)                                                                 |
| `test-without-assertion`        | medium        | `it()` / `test()` bodies with no `expect` / `assert` / `should` / `.toThrow` / snapshot match / sinon matcher / project-shaped helper                                         |
| `env-var-undeclared`            | medium / low  | `process.env.X` / `import.meta.env.X` reads not declared in any `.env.example` / Dockerfile / docker-compose `environment:` (paired LOW finding for dead env declarations)    |
| `package-export-mismatch`       | high          | `package.json` `main` / `module` / `types` / `bin` / `exports` paths that point at files missing on disk and without a TS source counterpart                                  |
| `schema-shape-divergence`       | medium        | Two exported types whose names share a common stem and whose field sets diverge by 1-2 keys (the classic `User` / `UserDTO` drift after a column rename)                      |
| `producer-consumer-field-drift` | high          | An Express / Fastify route reads `req.body.X` for a key that no `fetch` / `axios` callsite in the workspace ever sends to that URL                                            |
| `unsanitized-input-to-sink`     | high          | Taint flow from request-shaped sources (`req.*`, `searchParams.get`, `formData.get`) to dangerous sinks (raw SQL, `child_process.exec`, fs paths, `eval`, dynamic `import()`) |

Every new detector ships with unit + e2e coverage; the deterministic-layer
results stay in the report when the local LLM is unreachable.

### Changed

- **Default detector set is now principle-driven.** A detector ships
  OFF iff a standard ESLint rule (or plugin) covers the same surface
  — running both would just duplicate the project's own lint noise.
  Ten detectors land OFF on this principle: the seven full-overlap
  recommended-set rules (`public-any`, `long-function`, `long-file`,
  `deep-nesting`, `magic-numbers`, `console-log-prod`, `skip-tests`)
  plus three with partial overlap a plugin / stricter config catches
  (`silent-catch` ↔ `no-empty` with `allowEmptyCatch: false`,
  `todo-comments` ↔ `no-warning-comments`, `test-without-assertion` ↔
  `jest/expect-expect`).
- **Everything that ships ON is hard-spot territory** lint and tsc
  can't reach: cross-file reachability (`dead-*`, `hot-hub-file`),
  concurrency data-flow (`race-condition`, `api-race`,
  `shared-db-write`, `mutation`), AST / type clustering
  (`duplicate-*`, `similar-functions`, `schema-shape-divergence`),
  package / config contract (`bad-config`, `unused-deps`,
  `package-export-mismatch`, `env-var-undeclared`,
  `mutable-globals`), barrel / re-export contract
  (`re-export-shadow`, `default-export-name-drift`), and the new
  cross-file flow detectors (`producer-consumer-field-drift`,
  `unsanitized-input-to-sink`).
- **Parser:** `ImportRecord` now carries `reExportLocalNames` (alias-RHS,
  parallel to the existing `reExportNames`) so detectors that care about
  the final published name (e.g. `re-export-shadow`) see it directly.
  Existing consumers (`dead-api`) keep using `reExportNames`.

### UI

- **Tailwind v3 → v4 migration.** The PostCSS pipeline is replaced by the
  `@tailwindcss/vite` plugin; `postcss.config.js` and `tailwind.config.js`
  are gone. The full theme (colour tokens, font stacks, custom radii,
  tracking) lives in a `@theme` block in `src/ui/src/index.css`. A
  `@custom-variant dark` declaration preserves the `.dark` class trigger.
  Font CSS now loads through an HTML `<link>` because v4 processes the
  stylesheet before Vite's asset pipeline can resolve absolute URLs.
- **Type-checking under TypeScript 6.** Adds `src/ui/src/vite-env.d.ts`
  with `/// <reference types="vite/client" />` so side-effect imports of
  `.css` / `.svg` / `.png` files satisfy TS 6's stricter `TS2882` check.

### Tooling / dependencies

- `typescript` 5.9.3 → 6.0.3 (engine + UI)
- `@types/node` 24 → 25
- `tailwindcss` 3.4.19 → 4.3.0 (UI)
- `vite` 8.0.13 → 8.0.14 (UI patch group)
- `ts-jest` 29.4.10 → 29.4.11, `typescript-eslint` 8.59.4 → 8.60.0
  (dev-deps group)
- `actions/checkout` 4 → 6, `docker/build-push-action` 6 → 7,
  `docker/setup-buildx-action` 3 → 4, `docker/login-action` 3 → 4

### Build / repo hygiene

- ESLint config ignores `site/**` (landing page + vendored Tailwind
  bundle that emitted ~1k spurious errors when linted).
- Prettier ignores `site/**` for the same reason; a one-shot
  `prettier --write` sweep brought the rest of the tree in line with
  the project's prettier config.

### Tests

- 99 new tests across the 8 detector PRs (83 unit + 24 e2e) plus the
  cross-PR `settings-defaults` suite. Full Jest suite is now 362/362
  green.

[1.1.0-rc.1]: https://github.com/lBroth/rothunter/compare/v1.0.0-rc.7...v1.1.0-rc.1
