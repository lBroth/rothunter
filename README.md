<p align="center">
  <img src="logo.png" alt="RotHunter" width="160" />
</p>

<h1 align="center">RotHunter</h1>

<p align="center">
  Self-hosted code-hygiene engine for TypeScript / JavaScript codebases.<br/>
  Deterministic detectors + local LLM verdicts + dashboard.
</p>

## What it catches

24 detectors out of the box:

- Duplicate types / functions, dead modules / exports / handlers / api
- Race-condition / mutation / shared-db-write / api-race
- TSConfig / ESLint / Biome anti-patterns
- Silent catch, skip-tests (`.skip` / `.only`), TODO / FIXME / HACK comments
- Long files / functions, deep nesting
- Public `any`, mutable globals, unused deps, hot-hub files
- Similar functions (fuzzy clusters with canonical-pick + npm-package suggestion)

**Cross-service race detection** — `shared-db-write` and `api-race` run cross-workspace in monorepo mode, catching DB-column writes and write-endpoint calls that span service / repository boundaries. See [`docs/RACE-DETECTION.md`](./docs/RACE-DETECTION.md) for a walkthrough with three concrete scenarios.

### Coverage by mode

| Mode | Detectors |
|---|---|
| Single-workspace | All 24 |
| Multi-workspace (cross-repo via `rothunter.config.json`) | 9 cross-repo always-on (duplicate-type, duplicate-function, dead-module, dead-export, dead-api, long-function, deep-nesting, public-any, hot-hub-file) + the remaining 15 looped per workspace with workspace-namespaced fingerprints |

## Quick start

```bash
npm install
npm run dev:full     # auto-picks the fastest LLM backend + server + UI
# → server on :3000, UI on :5173, LLM on :8080
```

`dev:full` runs `scripts/start-llm.mjs` which auto-detects the best
available LLM backend on your host and starts it alongside the server +
UI. Selection order:

| # | Backend | When picked | Notes |
|---|---------|-------------|-------|
| 1 | **llama.cpp native** (`llama-server`) | `llama-server` on PATH | Uses Metal on macOS / CUDA on Linux when the binary was built with GPU support. |
| 2 | **Docker** (`docker compose up rothunter-llm`) | Docker Desktop available | Slower on macOS (no Metal inside the Linux VM) but works on any platform. |

Force a specific backend:

```bash
ROTHUNTER_LLM_BACKEND=llamacpp npm run dev:full   # or docker
ROTHUNTER_LLM_MODEL=bartowski/Qwen2.5-Coder-7B-Instruct-GGUF npm run dev:full
```

### Install an LLM backend

Pick ONE — `dev:full` picks the first available.

```bash
# Native llama.cpp (recommended — uses Metal on macOS, CUDA on Linux)
brew install llama.cpp           # macOS
# Linux: see https://github.com/ggml-org/llama.cpp

# Cross-platform sandbox: Docker (slower on macOS — no GPU passthrough)
docker --version
```

### Run pieces individually

```bash
npm run dev        # server + UI only (assumes the LLM is already up)
npm run llm        # auto-detected LLM only
npm run docker     # full docker-compose stack (server + llama.cpp sidecar)
```

### Or point at a remote LLM

If you already have an OpenAI-compatible endpoint (vLLM, OpenRouter, LM
Studio, an on-prem cluster …) skip the auto-launch entirely:

```bash
export ROTHUNTER_LLM_BASE_URL=https://my-llm.internal/v1
export ROTHUNTER_LLM_MODEL=Qwen2.5-Coder-14B-Instruct
export ROTHUNTER_LLM_API_KEY=...           # if the endpoint needs auth
export ROTHUNTER_LLM_CONCURRENCY=4         # 1 = sequential, raise for vLLM / llama.cpp --parallel N
npm run dev
```

## Layout

```
src/
  detectors/    — 24 deterministic detectors
  extraction/   — LLM confirmers
  parsers/      — ts-morph symbol + import graph
  graph/        — import-graph + entry-point resolution
  server/       — Fastify HTTP API + SSE scan stream
  ui/           — React / Vite / Tailwind dashboard
  docker/       — compose + Dockerfile
```

## Configuration

Every knob is an environment variable; see [`.env.example`](./.env.example) for the full list with defaults. The most common:

| Variable | Default | Purpose |
|---|---|---|
| `ROTHUNTER_PORT` | `3000` | HTTP API port |
| `ROTHUNTER_HOST` | `127.0.0.1` | Bind address — `0.0.0.0` exposes the API to LAN |
| `ROTHUNTER_FS_ROOTS` | `$HOME` (+ `/workspace` in docker) | Colon-separated allow-roots for workspace switches |
| `ROTHUNTER_LLM_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible LLM endpoint |
| `ROTHUNTER_LLM_MODEL` | `bartowski/Qwen2.5-Coder-14B-Instruct-GGUF` | HF repo id |
| `ROTHUNTER_LLM_CONCURRENCY` | `min(8, cores / 2)` | Parallel verdict requests |

## Security model

The HTTP API has no authentication — it relies on the loopback bind. Treat rothunter as a single-tenant developer tool, not a hosted service.

- Server binds `127.0.0.1` by default. Setting `ROTHUNTER_HOST=0.0.0.0` exposes the API to anyone on the network.
- The server can only read / write paths under `ROTHUNTER_FS_ROOTS`. Workspace switches outside this set return HTTP 403.
- LLM confirmers send code excerpts (±8 lines around the finding plus the enclosing signature) to the configured endpoint. Default is a loopback `llama.cpp` instance — nothing leaves the host. Verify the data-retention policy before pointing at a remote endpoint.

Full threat model + vulnerability reporting in [`SECURITY.md`](./SECURITY.md).

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for planned detectors (TypeScript misuse:
`any-leak` / `god-type` / `everything-optional` / `wide-string-type` /
`boolean-trap`) and other queued improvements.

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the detector-author checklist and quality bar.

## License

MIT — see [`LICENSE`](./LICENSE).
