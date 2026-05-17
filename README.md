<p align="center">
  <img src="logo.png" alt="RotHunter" width="160" />
</p>

<h1 align="center">RotHunter</h1>

<p align="center">
  Self-hosted code-hygiene engine for TypeScript / JavaScript codebases.<br/>
  Deterministic detectors + local Tier-3 LLM verdicts + dashboard.
</p>

## What it catches

24 detectors out of the box:

- Duplicate types / functions, dead modules / exports / handlers
- Race-condition / mutation / shared-db-write / api-race
- TSConfig / ESLint / Biome anti-patterns
- Silent catch, skip-tests (`.skip` / `.only`), TODO / FIXME / HACK comments
- Long files / functions, deep nesting
- Public `any`, mutable globals, unused deps, hot-hub files
- Similar functions (fuzzy clusters with canonical-pick + npm-package suggestion)

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
  detectors/    — 24 deterministic detectors
  extraction/   — Tier-3 LLM confirmers
  parsers/      — ts-morph symbol + import graph
  graph/        — import-graph + entry-point resolution
  server/       — Fastify HTTP API + SSE scan stream
  ui/           — React / Vite / Tailwind dashboard
  docker/       — compose + Dockerfile
```

## License

MIT
