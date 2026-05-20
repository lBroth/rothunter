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

| Service        | Image                                          | Purpose                                 |
|----------------|------------------------------------------------|-----------------------------------------|
| `rothunter`     | local build (Dockerfile)                       | Fastify API + React UI                  |
| `rothunter-llm` | `ghcr.io/ggerganov/llama.cpp:server-cuda`      | Qwen2.5-Coder-14B Q4_K_M LLM verdict |

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

## CPU-only fallback

Edit `docker-compose.yml`: switch the `rothunter-llm` image to
`ghcr.io/ggerganov/llama.cpp:server` and remove the `deploy.resources`
GPU reservation. Inference will be slower (~5-15 s per LLM verdict
vs ~1.5 s on GPU).

## Dev mode (no Docker)

```bash
# Both server + UI with HMR
npm run dev
```
