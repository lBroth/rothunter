# Security policy

## Reporting a vulnerability

Email security reports to the maintainers via a [GitHub security
advisory](https://github.com/lBroth/rothunter/security/advisories/new).
Do **not** open a public issue for security problems.

Please include:

- The version (`rothunter --version` or `package.json`).
- Steps to reproduce.
- Impact: data exposure, RCE, denial of service, …
- Optional: suggested fix.

We aim to acknowledge within 72 hours and ship a patch within 14 days
for high-severity issues.

## Security model

rothunter is a developer tool — not a hosted service. The threat model
assumes the operator runs the server on their own machine (or a
trusted developer VM) and points it at code they own.

### Network surface

- The HTTP API binds to `127.0.0.1` (loopback) by default. Every
  endpoint is reachable without authentication; the loopback bind is
  what keeps it private. **Do not** set `ROTHUNTER_HOST=0.0.0.0` on a
  shared host or LAN without putting a reverse proxy + auth in front.
- The Vite dev UI binds `0.0.0.0:5173` so phones on the same LAN can
  reach it. The UI talks to the API through Vite's `/api` proxy, so
  the API itself stays loopback.

### Filesystem scope

- The server only reads / writes paths under `ROTHUNTER_FS_ROOTS`
  (defaults to `$HOME`). Workspace switches that resolve outside the
  allow-root are rejected with HTTP 403.
- Per-workspace state lives at `<workspace>/.rothunter/`: scan
  history, marked-false-positives, kept-open overrides, marked-to-fix
  queue. Commit these to share triage state with the team, or add
  the directory to `.gitignore` to keep it local.
- `.rothunterignore` (gitignore syntax) and the workspace's `.gitignore`
  are honored before any detector runs.

### LLM payloads

- The triage / cluster / mutation / race confirmers send code
  excerpts to the configured LLM endpoint. By default this is a
  loopback `llama.cpp` instance, so nothing leaves the host. If you
  point `ROTHUNTER_LLM_BASE_URL` at a remote endpoint, code excerpts
  travel to that endpoint — review the endpoint's data-retention
  policy first.
- Excerpts are typically ±8 lines around a finding plus the
  enclosing function signature. Full files are never sent.

### Dependencies

- The engine itself depends on `fastify`, `ts-morph`, `zod`, `pino`,
  `ignore`. Patch updates land through Dependabot weekly.
- The dashboard depends on React 19, Vite 8, Tailwind 4, Lucide.

### Out of scope

- rothunter does not authenticate API callers, rate-limit them, or
  log per-user actions. Single-tenant on a developer workstation only.
- Hosted / multi-tenant deployments are not supported in v1. If you
  need that, terminate TLS + auth at a reverse proxy and treat the
  API as an internal-only service behind it.
