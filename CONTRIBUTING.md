# Contributing to rothunter

Thanks for considering a contribution. rothunter ships a TypeScript
engine, a Fastify HTTP server, and a React/Vite dashboard — every PR
should pass `npm test` + `npm run lint` + `npx tsc --noEmit` on both
roots (`./` and `./src/ui/`).

## Setup

```bash
git clone https://github.com/lBroth/rothunter
cd rothunter
npm run setup     # installs root + UI deps
cp .env.example .env   # optional — every var has a default
npm run dev:full  # server + UI + LLM
```

Node ≥ 24 is required.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(detector): add NestJS event-emitter race-condition pattern`
- `fix(server): split FP routing respects kept-open override`
- `docs(security): document FS allow-root scope`
- `refactor(parser): hoist tsconfig path resolution`

## Adding a detector

1. **Source**: `src/detectors/<id>.ts` exporting `detect<Id>(input)`.
   Take a `FileWalkingDetectorInput` or a custom shape — pick the
   tightest input that lets the detector run.
2. **Registry**: add the id to `src/detector-registry.ts` so the
   server lists it in the Settings page.
3. **Wire**: call the detector from `src/rothunter.ts`. File-walking
   + symbol-based + import-graph detectors each have a slot —
   follow the closest sibling.
4. **Test**: add `src/__tests__/<id>.test.ts`. Cover the positive
   case AND at least one false-positive shape — every detector
   ships a per-finding LLM verdict path on top of the deterministic
   check, but the deterministic layer must be precise on its own.
5. **Prompt rubric** (when adding a TriageConfirmer detector):
   update the rubric in `src/extraction/triage-confirmer.ts` so the
   LLM has detector-specific guidance.
6. **Docs**: add a row to `docs/DETECTORS.md` (id, severity,
   what it flags, what tunes it).

## Detector quality bar

- **No backwards-compatibility shims, no feature flags, no TODO
  stubs.** Three similar lines beat premature abstraction.
- **No `any`, no `@ts-ignore`.** Strict TypeScript across the board.
- **No `console.log` outside scripts.** Use the `pino` logger.
- **No global mutable state** except where the orchestrator's
  cache (e.g. `verdictCache`) makes that explicit and documented.
- **Snippets in evidence stay ≤ 60 lines.** Long snippets break the
  LLM context budget.

## Reporting bugs

Open an issue using the `bug_report` template. Include:
- rothunter version
- Node version (`node -v`)
- Detector id (if a specific detector misbehaves)
- Minimal reproducer (a fingerprint + the offending source snippet)

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
By participating you agree to abide by it.
