# RotHunter local stack

Single command brings up the web UI + scan engine + local LLM sidecar:

```bash
# Start (current dir is the workspace under scan).
docker compose -f src/docker/docker-compose.yml up --build

# Scan a specific repo:
ROTHUNTER_WORKSPACE_HOST=/path/to/your/repo \
  docker compose -f src/docker/docker-compose.yml up --build
```

Open <http://localhost:3000>.

## Components

| Service         | Image                               | Purpose                              |
| --------------- | ----------------------------------- | ------------------------------------ |
| `rothunter`     | local build (Dockerfile)            | Fastify API + React UI               |
| `rothunter-llm` | `ghcr.io/ggml-org/llama.cpp:server` | Qwen2.5-Coder-14B Q4_K_M LLM verdict |

## Volumes

- `${ROTHUNTER_WORKSPACE_HOST}` → `/workspace` (the repo RotHunter scans)
- `rothunter-models` (named volume) — caches the 9 GB GGUF download

## Scan history + false positives

RotHunter writes to `<workspace>/.rothunter/`:

```
.rothunter/
├── scans/
│   └── scan_<ts>_<rnd>.json      # one file per completed scan
├── false-positives.json          # fingerprints marked as FP
└── kept-open.json                # fingerprints the operator forced open

.rothunterignore                    # gitignore-syntax PATH exclusions
```

Both persist across container restarts because the workspace is mounted
read-write into the container.

## GPU opt-in

The default `rothunter-llm` image is the CPU-only `ghcr.io/ggml-org/llama.cpp:server`.
For CUDA, edit `docker-compose.yml`: switch the image to
`ghcr.io/ggml-org/llama.cpp:server-cuda` and uncomment the
`deploy.resources.reservations.devices` block. Inference drops from
~5–15 s per verdict (CPU) to ~1–2 s (GPU).

## Dev mode (no Docker)

```bash
# Both server + UI with HMR
npm run dev
```
