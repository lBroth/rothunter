#!/usr/bin/env node
// Launch the LLM sidecar for the dev loop.
//
// Strategy — auto-detect the fastest backend available on this host:
//
//   1. `llama-server` on PATH → run native llama.cpp (uses Metal on
//      macOS, CUDA / Vulkan on Linux when the binary was built with
//      GPU support).
//   2. Docker Desktop available → fall back to the docker-compose
//      `rothunter-llm` service. Slower on macOS (no Metal in the
//      Linux VM) but works on any platform with Docker.
//
// Set ROTHUNTER_LLM_BACKEND=llamacpp|docker to force a specific
// backend; otherwise we pick the first available from the list above.
//
// The script blocks until its child exits — `npm run dev:full` runs it
// alongside the server + UI via `concurrently -k` so killing one
// tears the whole stack down.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * Reject env values that would let a hostile environment inject extra
 * llama-server flags via the `spawn(..., [args])` argv. `spawn` does
 * not invoke a shell, so true shell injection is already blocked, but
 * a value starting with `-` would still be interpreted as a flag
 * (e.g. setting `ROTHUNTER_LLM_PORT='--alias --rpc 0.0.0.0:5000'`).
 * Tight allow-lists per env: model repo / file paths, integer port,
 * IPv4-ish host.
 */
function requireEnv(name, fallback, pattern) {
  const v = process.env[name] ?? fallback;
  if (!pattern.test(v)) {
    console.error(
      `[llm] refusing to launch — env ${name}=${JSON.stringify(v)} does not match ${pattern}`,
    );
    process.exit(1);
  }
  return v;
}
const MODEL_LLAMACPP_REPO = requireEnv(
  'ROTHUNTER_LLM_MODEL',
  'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
  /^[A-Za-z0-9._\-/]+$/,
);
const MODEL_LLAMACPP_FILE = requireEnv(
  'ROTHUNTER_LLM_MODEL_FILE',
  'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
  /^[A-Za-z0-9._\-/]+$/,
);
const PORT = requireEnv('ROTHUNTER_LLM_PORT', '8080', /^\d{1,5}$/);
// Loopback by default — the llama-server endpoint has no auth, so
// `--host 0.0.0.0` would let anyone on the LAN use the GPU and read
// the prompts we send. Override with `ROTHUNTER_LLM_HOST=0.0.0.0`
// only when you intentionally want LAN access (and ideally only
// behind a reverse proxy / VPN).
const HOST = requireEnv('ROTHUNTER_LLM_HOST', '127.0.0.1', /^[0-9.:a-fA-F]+$/);

function has(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function hasDocker() {
  return spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
}

function pickBackend() {
  const forced = process.env.ROTHUNTER_LLM_BACKEND;
  if (forced) return forced;
  if (has('llama-server')) return 'llamacpp';
  if (hasDocker()) return 'docker';
  return null;
}

/**
 * Marker file the server reads to know which model + port this script
 * launched. Lets the server pick the right model id without the
 * operator having to mirror env vars between processes.
 */
const MARKER_DIR = join(homedir(), '.rothunter');
const MARKER_PATH = join(MARKER_DIR, 'llm-active.json');

function writeMarker(payload) {
  try {
    mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(MARKER_PATH, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[llm] failed to write marker file: ${err.message}`);
  }
}

function clearMarker() {
  try {
    unlinkSync(MARKER_PATH);
  } catch {
    /* already gone */
  }
}

function run(cmd, args, marker) {
  console.log(`[llm] launching: ${cmd} ${args.join(' ')}`);
  if (marker) writeMarker(marker);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code) => {
    clearMarker();
    process.exit(code ?? 0);
  });
  const forward = (sig) => () => {
    clearMarker();
    child.kill(sig);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
}

const backend = pickBackend();
switch (backend) {
  case 'llamacpp':
    console.log(`[llm] native llama-server — ${MODEL_LLAMACPP_REPO}`);
    run(
      'llama-server',
      [
        '--hf-repo',
        MODEL_LLAMACPP_REPO,
        '--hf-file',
        MODEL_LLAMACPP_FILE,
        '--port',
        PORT,
        '--host',
        HOST,
        '--jinja',
        '-c',
        '8192',
        '-n',
        '256',
      ],
      { backend: 'llamacpp', model: MODEL_LLAMACPP_REPO, port: PORT },
    );
    break;
  case 'docker': {
    const compose = resolve(REPO_ROOT, 'src/docker/docker-compose.yml');
    if (!existsSync(compose)) {
      console.error(`[llm] docker-compose file not found at ${compose}`);
      process.exit(1);
    }
    console.log('[llm] docker fallback — slower on macOS (no Metal in the VM)');
    run('docker', ['compose', '-f', compose, 'up', 'rothunter-llm'], {
      backend: 'docker',
      model: MODEL_LLAMACPP_REPO,
      port: PORT,
    });
    break;
  }
  default:
    console.error(
      [
        '[llm] no LLM backend available. Install ONE of:',
        '  • brew install llama.cpp      (native llama-server, recommended)',
        '  • Docker Desktop              (docker-compose sidecar fallback)',
        '',
        'Or set ROTHUNTER_LLM_BASE_URL to an existing OpenAI-compatible',
        'endpoint (vLLM, OpenRouter, LM Studio, …) and start the server /',
        'UI directly with `npm run server` and `npm run ui`.',
      ].join('\n'),
    );
    process.exit(1);
}
