---
name: Bug report
about: A detector misbehaves, the server crashes, the UI shows something wrong.
labels: bug
---

## What happened

(One sentence — what did rothunter do, and what should it have done?)

## Repro

- rothunter version: `package.json` value
- Node version: `node -v`
- OS: macOS / Linux / Docker
- LLM backend: llama.cpp native / docker / remote (`ROTHUNTER_LLM_BASE_URL=...`)
- Detector id (if a specific detector misbehaves): `silent-catch` / `magic-numbers` / …
- Minimal source snippet that triggers it (anonymise as needed).

```ts
// paste the smallest input that reproduces the issue
```

## Expected vs actual

- **Expected:** ...
- **Actual:** ...

## Logs / screenshots

(Server log lines, browser-console errors, or a dashboard screenshot.)
