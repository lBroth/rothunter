<p align="center">
  <img src="logo.png" alt="RotHunter" width="160" />
</p>

<h1 align="center">RotHunter</h1>

<p align="center">
  Self-hosted code-hygiene engine for TypeScript / JavaScript codebases.<br/>
  Deterministic detectors + local Tier-3 LLM verdicts + dashboard.
</p>

## What it catches

26 detectors out of the box:

- Duplicate types / functions, dead modules / exports / handlers / api
- Race-condition / mutation / shared-db-write / api-race
- TSConfig / ESLint / Biome anti-patterns
- Silent catch, skip-tests (`.skip` / `.only`), TODO / FIXME / HACK comments
- Long files / functions, deep nesting
- Public `any`, mutable globals, unused deps, hot-hub files
- Similar functions (fuzzy clusters with canonical-pick + npm-package suggestion)
- Secret leaks (AWS / GitHub / OpenAI / Anthropic / Slack / Stripe / GCP / Azure SAS / Twilio / DB DSN / PEM / generic)
- Same-name evolution (back-port-forgotten copies, git-touched gap)

### Coverage by mode

| Mode | Detectors |
|---|---|
| Single-workspace | All 26 |
| Multi-workspace (cross-repo via `rothunter.config.json`) | 9 cross-repo always-on (duplicate-type, duplicate-function, dead-module, dead-export, dead-api, long-function, deep-nesting, public-any, hot-hub-file) + the remaining 17 looped per workspace with workspace-namespaced fingerprints |

## Quick start

```bash
npm install
npm run dev
# → server on :3000, UI on :5173
```

Set a Tier-3 LLM endpoint (llama.cpp, vLLM, mlx_lm.server, Ollama, …):

```bash
export ROTHUNTER_LLM_BASE_URL=http://127.0.0.1:8080/v1
export ROTHUNTER_LLM_MODEL=bartowski/Qwen2.5-Coder-14B-Instruct-GGUF
export ROTHUNTER_LLM_CONCURRENCY=4   # 1 = sequential, raise for vLLM / llama.cpp --parallel N
```

Docker compose stack (server + llama.cpp sidecar):

```bash
npm run docker
```

## Layout

```
src/
  detectors/    — 26 deterministic detectors
  extraction/   — Tier-3 LLM confirmers
  parsers/      — ts-morph symbol + import graph
  graph/        — import-graph + entry-point resolution
  server/       — Fastify HTTP API + SSE scan stream
  ui/           — React / Vite / Tailwind dashboard
  docker/       — compose + Dockerfile
```

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for planned detectors (TypeScript misuse:
`any-leak` / `god-type` / `everything-optional` / `wide-string-type` /
`boolean-trap`) and other queued improvements.

## License

MIT
