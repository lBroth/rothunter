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

Full detector list with severities + tunables: [`docs/DETECTORS.md`](./docs/DETECTORS.md).

### Coverage by mode

| Mode | Detectors |
|---|---|
| Single-workspace | All 24 |
| Multi-workspace (cross-repo via `rothunter.config.json`) | 9 cross-repo always-on (duplicate-type, duplicate-function, dead-module, dead-export, dead-api, long-function, deep-nesting, public-any, hot-hub-file) + the remaining 15 looped per workspace with workspace-namespaced fingerprints |

## Quick start

Three paths. Pick one — they all end at <http://localhost:3000>.

### 1. Docker (fastest, no clone)

```bash
# scan the repo in $(pwd) — needs an LLM endpoint
docker run --rm -p 3000:3000 \
  -v "$(pwd):/workspace" \
  -e ROTHUNTER_LLM_BASE_URL="$LLM_URL" \
  ghcr.io/lbroth/rothunter:latest
```

No `ROTHUNTER_LLM_BASE_URL`? Use the compose stack — it ships an
llama.cpp sidecar that downloads a 9 GB model on first boot:

```bash
git clone https://github.com/lBroth/rothunter && cd rothunter
ROTHUNTER_WORKSPACE_HOST=/path/to/your-repo npm run docker
```

### 2. npx (no Docker)

```bash
# server + UI on :3000; point at any OpenAI-compatible LLM endpoint
ROTHUNTER_LLM_BASE_URL=http://127.0.0.1:8080/v1 \
  npx @lbroth/rothunter
```

The npx flow boots only the server + dashboard. Run the LLM yourself
with `brew install llama.cpp && llama-server --hf-repo bartowski/Qwen2.5-Coder-14B-Instruct-GGUF` (or aim
`ROTHUNTER_LLM_BASE_URL` at vLLM / OpenRouter / LM Studio).

### 3. Clone + dev mode (contributor flow)

```bash
git clone https://github.com/lBroth/rothunter && cd rothunter
npm run setup        # root + UI deps
npm run dev:full     # server + UI + auto-launched llama.cpp
```

`dev:full` auto-detects an LLM backend on `PATH`:

| # | Backend | When picked |
|---|---------|-------------|
| 1 | **llama.cpp native** (`llama-server`) | `llama-server` on PATH (`brew install llama.cpp`) — uses Metal / CUDA when the binary supports it |
| 2 | **Docker** (`docker compose up rothunter-llm`) | Docker Desktop available |

Force a backend or model:

```bash
ROTHUNTER_LLM_BACKEND=llamacpp npm run dev:full
ROTHUNTER_LLM_MODEL=bartowski/Qwen2.5-Coder-7B-Instruct-GGUF npm run dev:full
```

### Point at a remote LLM

Skip the auto-launch when you already have an OpenAI-compatible endpoint:

```bash
export ROTHUNTER_LLM_BASE_URL=https://my-llm.internal/v1
export ROTHUNTER_LLM_MODEL=Qwen2.5-Coder-14B-Instruct
export ROTHUNTER_LLM_API_KEY=...           # if the endpoint needs auth
export ROTHUNTER_LLM_CONCURRENCY=4         # raise for vLLM / llama.cpp --parallel N
npx @lbroth/rothunter
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
