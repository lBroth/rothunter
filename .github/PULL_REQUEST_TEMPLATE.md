## What changes

(One sentence per change. Prefer "fix(silent-catch): respect /_ expected _/ pragma" form.)

## Why

(Reference the issue or describe the user-visible payoff.)

## Detector-author checklist

If this PR adds or changes a detector:

- [ ] Detector id added / kept in `src/detector-registry.ts`.
- [ ] Wired from `src/rothunter.ts` (single + multi-workspace as appropriate).
- [ ] Paired test in `src/__tests__/<id>.test.ts` covering at least one
      positive AND one false-positive shape.
- [ ] Prompt rubric extended in `src/extraction/triage-confirmer.ts`
      if the detector routes through `TriageConfirmer`.
- [ ] Row added / updated in `docs/DETECTORS.md`.

## Other checks

- [ ] `npm test` passes
- [ ] `npm run lint`, `npx tsc --noEmit` (both roots) clean
- [ ] No new abstractions beyond what the task requires
